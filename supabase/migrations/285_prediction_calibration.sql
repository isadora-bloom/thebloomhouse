-- ---------------------------------------------------------------------------
-- 285_prediction_calibration.sql
-- ---------------------------------------------------------------------------
-- Wave 18 — Prediction calibration loop (Brier + reliability + drift).
--
-- Anchor docs (~/.claude memory/):
--   - bloom-constitution.md (forensic identity reconstruction; the
--     forensic record's job is to be MORE COMPLETE than the couple's
--     own memory. A system that predicts close-probability without
--     measuring those predictions is forensic in name only — the model
--     could be wildly miscalibrated and nobody would know.)
--   - feedback_measure_dont_assume.md (a system that predicts must also
--     measure its predictions; this migration is the substrate)
--   - bloom-wave4-5-6-master-plan.md (Wave 5A spec — close-probability
--     is the canonical prediction; Wave 18 closes the loop without
--     touching the prediction surface)
--   - bloom-phase-b-decisions.md (append-only audit pattern; we mirror
--     attribution_events / lifecycle_transitions)
--
-- Why this migration exists
-- -------------------------
-- Wave 5A's per-couple-derive.ts writes
-- couple_intel.predicted_close_probability_pct. Wave 11's lifecycle
-- state machine eventually marks the wedding as booked / lost /
-- cancelled / completed (post_event after event_date). Between those
-- two moments — sometimes 30+ days — there is no record of WHAT the
-- prediction was at WHICH moment. couple_intel only stores the LATEST
-- prediction, so by the time a couple books, the prediction that
-- "predicted" the booking has been overwritten N times.
--
-- This migration adds two append-only tables:
--   1. prediction_snapshots — one row per (wedding, prediction kind,
--      moment-in-time). Captured at derive time by record-prediction.ts.
--      Never updated; only inserted.
--   2. prediction_outcomes — one row per (snapshot, actual outcome).
--      Inserted by measure-outcomes.ts once the wedding reaches a
--      terminal lifecycle state. Closes the loop.
--
-- Plus one queue table:
--   3. measure_outcome_jobs — drainable queue for the calibration sweep
--      (so a lifecycle transition can fire-and-forget enqueue the
--      measurement without blocking the transition).
--
-- prediction_kind is text rather than an enum so future predictions
-- (persona_label correctness, tour_likely, win-probability per stage)
-- can land without a schema migration. Today the only kind emitted is
-- 'close_probability_pct'.
--
-- The matched_prediction column is intentionally generic: for
-- probability predictions it means "≥50 and booked OR <50 and lost";
-- for label predictions it would mean "predicted label == actual
-- label". Each prediction_kind defines its own semantics in
-- analyze.ts.
--
-- Idempotent: every CREATE / ALTER uses IF NOT EXISTS or DO/EXCEPTION.
-- Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — prediction_snapshots
-- ============================================================================
-- One row per recorded prediction. snapshotted_at is when Wave 5A
-- wrote the prediction; the matching prediction_outcomes row's
-- measured_at is when the outcome was observed (terminal lifecycle
-- transition). The delta (measured_at - snapshotted_at) is the
-- evidence-window of the prediction — important for drift analysis.

CREATE TABLE IF NOT EXISTS public.prediction_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  prediction_kind text NOT NULL,
  predicted_value jsonb NOT NULL,
  predicted_confidence_0_100 int,
  prediction_source text,
  prompt_version text,
  cost_cents numeric(10, 4),
  snapshotted_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.prediction_snapshots IS
  'Wave 18 (mig 285). Append-only history of predictions made by the '
  'platform. One row per (wedding, kind, moment-in-time). Wave 5A '
  'per-couple-derive writes close_probability_pct snapshots; future '
  'waves may add persona_label / tour_likely / win_probability_per_'
  'stage. Read by calibration analyzer; never updated.';

COMMENT ON COLUMN public.prediction_snapshots.prediction_kind IS
  'Free-text identifier of WHAT was predicted. Today only '
  '''close_probability_pct''. Future kinds: ''persona_label'', '
  '''tour_likely'', ''win_probability_<stage>''. Each kind defines '
  'its own actual_outcome / matched_prediction semantics in '
  'analyze.ts.';

COMMENT ON COLUMN public.prediction_snapshots.predicted_value IS
  'jsonb capturing the prediction at snapshot time. Shape depends on '
  'prediction_kind. For close_probability_pct: { pct_0_100: number }.';

CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_venue_kind_time
  ON public.prediction_snapshots (venue_id, prediction_kind, snapshotted_at DESC);

CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_wedding
  ON public.prediction_snapshots (wedding_id, prediction_kind, snapshotted_at DESC);

ALTER TABLE public.prediction_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_prediction_snapshots"
  ON public.prediction_snapshots;
CREATE POLICY "auth_select_prediction_snapshots"
  ON public.prediction_snapshots
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_prediction_snapshots"
  ON public.prediction_snapshots;
CREATE POLICY "auth_insert_prediction_snapshots"
  ON public.prediction_snapshots
  FOR INSERT TO authenticated WITH CHECK (true);

-- ============================================================================
-- STEP 2 — prediction_outcomes
-- ============================================================================
-- One row per snapshot, written when the wedding reaches a terminal
-- lifecycle state (booked / lost / cancelled / post_event after
-- event_date). matched_prediction + error_magnitude carry the
-- per-kind interpretation:
--
--   close_probability_pct:
--     matched_prediction = (predicted >= 50 AND booked)
--                          OR (predicted < 50 AND lost/cancelled)
--     error_magnitude     = | predicted - (100 if booked else 0) |
--
-- One outcome per snapshot. A snapshot taken in proposal_active gets
-- ONE outcome row when the wedding later hits booked OR lost. A
-- second snapshot at a later derive gets its own outcome row when
-- the same terminal state is observed.
--
-- This means a wedding with N derives + one booked outcome has N
-- prediction_outcomes rows, one per snapshot. The calibration
-- analyzer can pick the most-recent-N-days window into the past
-- from the terminal state, so predictions made "just before" the
-- outcome don't dominate.

CREATE TABLE IF NOT EXISTS public.prediction_outcomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prediction_snapshot_id uuid REFERENCES public.prediction_snapshots(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  actual_outcome jsonb,
  matched_prediction boolean,
  error_magnitude numeric(7, 2),
  measured_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.prediction_outcomes IS
  'Wave 18 (mig 285). One row per prediction_snapshot, written by '
  'measure-outcomes.ts when the wedding reaches a terminal lifecycle '
  'state. Each prediction_kind defines its own actual_outcome shape '
  'and matched_prediction / error_magnitude semantics. Read by '
  'calibration analyzer.';

COMMENT ON COLUMN public.prediction_outcomes.actual_outcome IS
  'jsonb describing what actually happened. For close_probability_pct: '
  '{ booked: boolean, lifecycle_stage: text, days_to_terminal: int }.';

COMMENT ON COLUMN public.prediction_outcomes.matched_prediction IS
  'true if the prediction was "correct" by the kind''s rule. For '
  'probability predictions: predicted >= 50 AND booked OR predicted '
  '< 50 AND lost/cancelled.';

COMMENT ON COLUMN public.prediction_outcomes.error_magnitude IS
  'Numeric prediction error for Brier-style scoring. For probability '
  'predictions: | predicted_value - (100 if booked else 0) |. Lower '
  'is better.';

-- A snapshot has at most one outcome row. Enforced as a partial unique
-- index so re-running measure-outcomes is idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prediction_outcomes_snapshot
  ON public.prediction_outcomes (prediction_snapshot_id)
  WHERE prediction_snapshot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_venue_measured
  ON public.prediction_outcomes (venue_id, measured_at DESC);

CREATE INDEX IF NOT EXISTS idx_prediction_outcomes_wedding
  ON public.prediction_outcomes (wedding_id, measured_at DESC);

ALTER TABLE public.prediction_outcomes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_prediction_outcomes"
  ON public.prediction_outcomes;
CREATE POLICY "auth_select_prediction_outcomes"
  ON public.prediction_outcomes
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_prediction_outcomes"
  ON public.prediction_outcomes;
CREATE POLICY "auth_insert_prediction_outcomes"
  ON public.prediction_outcomes
  FOR INSERT TO authenticated WITH CHECK (true);

-- ============================================================================
-- STEP 3 — measure_outcome_jobs (drainable queue)
-- ============================================================================
-- The lifecycle stage-triggers fan-out (Wave 11) writes a job here
-- when a wedding hits a terminal stage. The calibration sweep drains
-- the queue in batches by calling measureOutcomes(). Same shape as
-- identity_reconstruction_jobs / lifecycle_transition_jobs for ops
-- consistency.

CREATE TABLE IF NOT EXISTS public.measure_outcome_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  snapshots_measured int,
  error_text text
);

COMMENT ON TABLE public.measure_outcome_jobs IS
  'Wave 18 (mig 285). Queue drained by the calibration sweep. Enqueued '
  'when a wedding hits a terminal lifecycle stage (booked / lost / '
  'cancelled / post_event). Worker calls measureOutcomes for the '
  'wedding, which writes prediction_outcomes rows for every dangling '
  'prediction_snapshot.';

CREATE INDEX IF NOT EXISTS idx_measure_outcome_jobs_dequeue
  ON public.measure_outcome_jobs (status, enqueued_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_measure_outcome_jobs_wedding
  ON public.measure_outcome_jobs (wedding_id, enqueued_at DESC);

ALTER TABLE public.measure_outcome_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_measure_outcome_jobs"
  ON public.measure_outcome_jobs;
CREATE POLICY "auth_select_measure_outcome_jobs"
  ON public.measure_outcome_jobs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_measure_outcome_jobs"
  ON public.measure_outcome_jobs;
CREATE POLICY "auth_insert_measure_outcome_jobs"
  ON public.measure_outcome_jobs
  FOR INSERT TO authenticated WITH CHECK (true);

COMMIT;

-- ----------------------------------------------------------------------------
-- STEP 4 — NOTIFY pgrst (refresh REST schema cache)
-- ----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
