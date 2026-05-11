-- ============================================================================
-- Migration 278 — Wave 11: canonical 13-stage lifecycle state machine.
-- ============================================================================
--
-- Anchor docs (see ~/.claude memory/):
--   - bloom-constitution.md (Point-Zero / forensic identity reconstruction
--     pattern; this migration adds the 13-stage life-of-couple backbone
--     parallel to the existing 8-status weddings.status enum)
--   - bloom-wave4-identity-reconstruction.md (one canonical truth + a
--     parallel jobs queue that crons drain; this migration mirrors that
--     shape for lifecycle)
--   - feedback_deep_fix_vs_bandaid.md (LLM for soft transitions only;
--     determinism for clear ones — encoded in lifecycle_transitions.
--     transition_kind: 'deterministic' | 'llm_judged' | 'operator_override'
--     | 'auto_stuck')
--
-- WHAT THIS ADDS
-- --------------
-- Pre-fix the codebase has weddings.status (coarse 8-value enum) +
-- wedding_lifecycle_events (audit). Neither captures the real 11-stage
-- client journey (Pre-touch / First touch / Nurture / Tour scheduled /
-- Tour completed / Proposal / Booked / Planning / Day-of / Post-event /
-- Long-tail), plus 2 terminal stages (lost / cancelled) = 13 total.
-- Stage-stuck couples are invisible and stage-transition automation
-- (booked → planning Sage; completed → review solicitation) has no
-- backbone to fire from.
--
-- Wave 11 ADDS the new canonical field as a parallel column. weddings.
-- status stays as legacy compat (every existing writer + reader is
-- untouched). Eventually status becomes a derived view of
-- lifecycle_stage; not in this wave.
--
--   1. weddings.lifecycle_stage          — 13-value canonical field
--   2. weddings.lifecycle_stage_set_at   — when did we last transition
--   3. weddings.lifecycle_transition_count — running count, audit telemetry
--   4. lifecycle_transitions             — append-only audit, one row per
--                                          transition
--   5. lifecycle_transition_jobs         — queue for soft-transition LLM
--                                          judge work
--
-- Idempotent: every CREATE / ADD uses IF NOT EXISTS or DROP-THEN-CREATE.
-- Permissive RLS matches the 225/226/246 doctrine — venue scope owned
-- upstream by membership context.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- STEP 1 — weddings columns
-- ----------------------------------------------------------------------------
-- Nullable on purpose. Existing rows have NULL until the first sweep.
-- A NULL value means "the state machine has not run yet on this row" —
-- distinguishable from any of the 13 valid stages.

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS lifecycle_stage text;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS lifecycle_stage_set_at timestamptz;

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS lifecycle_transition_count int NOT NULL DEFAULT 0;

-- Drop a pre-existing partial / mismatched CHECK before re-adding the
-- canonical one. Wraps in DO block so a missing constraint is not an error.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'weddings_lifecycle_stage_check'
  ) THEN
    ALTER TABLE public.weddings DROP CONSTRAINT weddings_lifecycle_stage_check;
  END IF;
END;
$$;

ALTER TABLE public.weddings
  ADD CONSTRAINT weddings_lifecycle_stage_check
  CHECK (
    lifecycle_stage IS NULL
    OR lifecycle_stage IN (
      'pre_touch',
      'first_touch',
      'nurture',
      'tour_scheduled',
      'tour_completed',
      'proposal_active',
      'booked',
      'planning_active',
      'day_of',
      'post_event',
      'long_tail',
      'lost',
      'cancelled'
    )
  );

COMMENT ON COLUMN public.weddings.lifecycle_stage IS
  'Wave 11 canonical 13-stage backbone. Computed by '
  'src/lib/services/lifecycle/state-machine.ts from evidence. Parallel '
  'to (does NOT replace) weddings.status — that legacy enum stays for '
  'now. Migration 278.';

COMMENT ON COLUMN public.weddings.lifecycle_stage_set_at IS
  'Wall-clock timestamp of the most recent lifecycle_stage transition. '
  'Used by the stage-stuck detector ("couple has been in proposal_active '
  '> 14d, soft-judge") and intel narratives.';

COMMENT ON COLUMN public.weddings.lifecycle_transition_count IS
  'Running count of lifecycle_stage changes. Telemetry — a high count '
  'on an open wedding is a back-and-forth signal worth surfacing.';

-- A partial index lets the stuck-detector and stage-bucket dashboards
-- scan the active universe cheaply once the long-tail of lost/cancelled
-- rows grows large.
CREATE INDEX IF NOT EXISTS idx_weddings_lifecycle_stage
  ON public.weddings (lifecycle_stage, lifecycle_stage_set_at DESC)
  WHERE lifecycle_stage IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_weddings_lifecycle_stage_venue
  ON public.weddings (venue_id, lifecycle_stage)
  WHERE lifecycle_stage IS NOT NULL;

-- ----------------------------------------------------------------------------
-- STEP 2 — lifecycle_transitions (audit log)
-- ----------------------------------------------------------------------------
-- One row per detected transition. Shape:
--   - from_stage / to_stage: nullable when from is unknown (first
--     classification) or to is unset (rare reset path).
--   - transition_kind: deterministic | llm_judged | operator_override |
--     auto_stuck. The 'auto_stuck' kind is logged when the sweep
--     re-affirms a long-running stage past its stuck threshold (i.e.
--     the LLM judge ran and confirmed "still in this stage, here is
--     why"), so we can distinguish "judged + held" from "judged +
--     advanced". 'operator_override' carries transitioned_by uuid.
--   - evidence jsonb: the rule that fired, raw signals consulted (event
--     dates, recent interactions, etc), and any LLM judge output.
--   - reasoning text: short human explanation. For deterministic it's
--     the rule name; for llm_judged it's the judge's reasoning prose.

CREATE TABLE IF NOT EXISTS public.lifecycle_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  from_stage text,
  to_stage text NOT NULL,
  transition_kind text NOT NULL CHECK (transition_kind IN (
    'deterministic',
    'llm_judged',
    'operator_override',
    'auto_stuck'
  )),
  evidence jsonb,
  reasoning text,
  confidence numeric,
  transitioned_at timestamptz NOT NULL DEFAULT now(),
  transitioned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.lifecycle_transitions IS
  'Wave 11 lifecycle-transition audit log. One row per recognized '
  'transition or stuck-stage re-affirm. Read by the wedding detail '
  'page transition timeline, intel narratives, and the sweep stuck-'
  'detector idempotency guard. Migration 278.';

COMMENT ON COLUMN public.lifecycle_transitions.transition_kind IS
  'deterministic — evidence rule (tour scheduled / booked / event '
  'past). llm_judged — soft transition decided by Haiku judge. '
  'operator_override — coordinator manual override. auto_stuck — '
  'sweep re-affirmed stage past stuck threshold.';

CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_wedding
  ON public.lifecycle_transitions (wedding_id, transitioned_at DESC);

CREATE INDEX IF NOT EXISTS idx_lifecycle_transitions_venue_to_stage
  ON public.lifecycle_transitions (venue_id, to_stage, transitioned_at DESC);

ALTER TABLE public.lifecycle_transitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_lifecycle_transitions"
  ON public.lifecycle_transitions;
CREATE POLICY "auth_select_lifecycle_transitions"
  ON public.lifecycle_transitions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_lifecycle_transitions"
  ON public.lifecycle_transitions;
CREATE POLICY "auth_insert_lifecycle_transitions"
  ON public.lifecycle_transitions
  FOR INSERT TO authenticated WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 3 — lifecycle_transition_jobs (soft-transition queue)
-- ----------------------------------------------------------------------------
-- The sweep enqueues a job when a wedding is candidate for soft
-- transition (e.g. silent post-proposal, booked but no planning
-- activity, post_event but no review yet). The LLM judge processes
-- queued jobs in batches, writes the resulting transition (or holds
-- the stage with an auto_stuck row).
--
-- Same shape as identity_reconstruction_jobs / couple_intel_jobs
-- (migrations 260 / 261) for ops consistency.

CREATE TABLE IF NOT EXISTS public.lifecycle_transition_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  current_stage text,
  candidate_stage text,
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.lifecycle_transition_jobs IS
  'Wave 11 soft-transition queue. Enqueue triggers: sweep finds a '
  'wedding past its stage stuck threshold (e.g. proposal_active > 14d '
  'silent; booked > 30d no planning) and queues the Haiku judge. '
  'Worker drains the queue in batches, writes lifecycle_transitions '
  'rows (kind = llm_judged or auto_stuck depending on judge output). '
  'Migration 278.';

CREATE INDEX IF NOT EXISTS idx_lifecycle_transition_jobs_dequeue
  ON public.lifecycle_transition_jobs (status, enqueued_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_lifecycle_transition_jobs_wedding
  ON public.lifecycle_transition_jobs (wedding_id, enqueued_at DESC);

ALTER TABLE public.lifecycle_transition_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_lifecycle_transition_jobs"
  ON public.lifecycle_transition_jobs;
CREATE POLICY "auth_select_lifecycle_transition_jobs"
  ON public.lifecycle_transition_jobs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_lifecycle_transition_jobs"
  ON public.lifecycle_transition_jobs;
CREATE POLICY "auth_insert_lifecycle_transition_jobs"
  ON public.lifecycle_transition_jobs
  FOR INSERT TO authenticated WITH CHECK (true);

-- ----------------------------------------------------------------------------
-- STEP 4 — NOTIFY pgrst (refresh REST schema cache)
-- ----------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
