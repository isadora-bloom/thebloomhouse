-- ---------------------------------------------------------------------------
-- 268_venue_thesis.sql
-- ---------------------------------------------------------------------------
-- Wave 5D — Onboarding bootstrap (venue thesis) + cross-venue overlap.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 5D auto-generates a venue's "thesis" once
--     ~50 reconstructions have landed; cross-venue overlap surfaces shared
--     cohort signals at AGGREGATE level only — never name couples across
--     venue boundaries)
--   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose; cross-venue
--     comparison NEVER reads couple-level data — only the peer's
--     venue_thesis aggregate output)
--   - feedback_parallel_stream_safety.md (Wave 5D holds migration 268;
--     Wave 7A holds 267; Wave 6C holds 269 — pre-allocated by master plan)
--
-- Why this migration exists
-- -------------------------
-- A new venue should never be onboarded "blank". Once Wave 4 has produced
-- ~50 reconstructed couples, Wave 5D's Sonnet synthesizer reads that
-- substrate and produces a strategic identity reconstruction: archetype,
-- over-indexed personas vs market average, recurring emotional landscape,
-- conversion signature, voice thesis, service demand strengths + gaps,
-- and an operator-facing brief paragraph. Stored on venue_thesis (one row
-- per venue, upserted on regeneration).
--
-- At Wedgewood scale (100+ venues), cross_venue_overlap stores the
-- aggregate-only intersection between an anchor venue's thesis and each
-- peer venue's thesis: shared persona archetypes, shared emerging themes,
-- shared service-demand gaps, shared voice principles. The peer's
-- couple_identity_profile rows are NEVER read — only the peer's
-- venue_thesis aggregate. Privacy doctrine: aggregate ≠ disclose.
--
-- Storage shape:
--   * one venue_thesis row per venue (most-recent generation),
--   * a venue_thesis_jobs queue mirroring the venue_intel_jobs pattern
--     (status / trigger_signal / atomic-claim worker model),
--   * one cross_venue_overlap row per (anchor, peer) pair — unique
--     constraint enforces dedupe on regeneration.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — venue_thesis (one row per venue)
-- ============================================================================
-- The thesis itself is a structured Sonnet output. The shape is locked by
-- src/config/prompts/venue-thesis.ts validateVenueThesisOutput, but stored
-- as jsonb so the prompt can evolve without a migration.

CREATE TABLE IF NOT EXISTS public.venue_thesis (
  venue_id uuid PRIMARY KEY REFERENCES public.venues(id) ON DELETE CASCADE,
  thesis jsonb NOT NULL,
  -- Snapshot of how many reconstructed couples were in scope when this
  -- thesis was generated. Hoisted out of the jsonb so the freshness card
  -- can render "synthesized from 47 couples" without parsing.
  couples_at_generation int NOT NULL,
  last_generated_at timestamptz NOT NULL DEFAULT now(),
  -- Generation count tracks how many times the thesis has been refreshed
  -- for this venue (initial + drifts + manual regenerations). Useful for
  -- spotting venues whose thesis has churned (thesis-instability is a
  -- diagnostic signal).
  generation_count int NOT NULL DEFAULT 1,
  prompt_version text NOT NULL,
  -- Cumulative cost across thesis generations for this venue.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.venue_thesis IS
  'owner:intelligence. Wave 5D venue thesis — strategic identity '
  'reconstruction from the venue''s reconstructed couple cohort. One row '
  'per venue, upserted on (re)generation. Read by /admin/onboarding/'
  'thesis dashboard + VenueThesisPanel onboarding embed. Refresh '
  'trigger: every 25 new reconstructions OR weekly drift OR manual. '
  'Aggregate-not-disclose: thesis NEVER names couples; sensitive themes '
  'reach as count-only summaries. Cost target $0.10-$0.20 per generation '
  '(one Sonnet call). Migration 268.';

COMMENT ON COLUMN public.venue_thesis.thesis IS
  'Structured Sonnet output: venue_archetype (LLM-invented label, not '
  'enum), over_indexed_personas, recurring_emotional_landscape, '
  'conversion_signature, voice_thesis, service_demand_strengths, '
  'service_demand_gaps, operator_brief_paragraph, cohort_size_at_'
  'generation, refusals. Schema enforced by validateVenueThesisOutput in '
  'src/config/prompts/venue-thesis.ts.';

COMMENT ON COLUMN public.venue_thesis.couples_at_generation IS
  'Couples in scope at generation time. Hoisted from thesis.cohort_size_'
  'at_generation so freshness panels can render "from 47 couples" '
  'without parsing jsonb. Drives the "regenerate when cohort grew '
  '25%" drift policy in the sweep.';

COMMENT ON COLUMN public.venue_thesis.cost_cents IS
  'Cumulative dollar cost (in cents, sub-cent precision) of every '
  'generation for this venue. Each (re)generation adds the per-call cost '
  'on top of the existing cumulative.';

CREATE INDEX IF NOT EXISTS idx_venue_thesis_venue_generated
  ON public.venue_thesis (venue_id, last_generated_at DESC);

COMMENT ON INDEX public.idx_venue_thesis_venue_generated IS
  'Drift / freshness index. Sweep picks venues whose last_generated_at '
  'is older than 7 days OR whose cohort has grown ≥25% since last '
  'generation and enqueues a regeneration job.';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_venue_thesis_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_thesis_touch ON public.venue_thesis;
CREATE TRIGGER trg_venue_thesis_touch
  BEFORE UPDATE ON public.venue_thesis
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_venue_thesis_updated_at();

-- ============================================================================
-- STEP 2 — venue_thesis_jobs (queue table)
-- ============================================================================
-- Same shape as venue_intel_jobs (mig 262) and couple_intel_jobs (mig 261).
-- Per-venue volume is low (one thesis per venue per week + occasional
-- 25-couple-step refreshes). Worker drains via cron dispatcher.

CREATE TABLE IF NOT EXISTS public.venue_thesis_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that produced this enqueue.
  -- Common values: 'cohort_milestone' (every 25 reconstructions) |
  -- 'weekly_drift' | 'manual_force' | 'admin_backfill'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.venue_thesis_jobs IS
  'owner:intelligence. Wave 5D venue thesis queue. Enqueue triggers: '
  '(a) cohort_milestone fires when couple_identity_profile inserts cross '
  '25/50/75/100 multiples for a venue, (b) weekly_drift fires from the '
  'sweep when last_generated_at < 7 days, (c) manual_force from the '
  'admin endpoint. Worker drains 5 jobs per tick (low volume, one per '
  'venue per refresh). Migration 268.';

COMMENT ON COLUMN public.venue_thesis_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label so new triggers can land '
  'without a migration. Common values: cohort_milestone | weekly_drift | '
  'manual_force | admin_backfill.';

CREATE INDEX IF NOT EXISTS idx_venue_thesis_jobs_dequeue
  ON public.venue_thesis_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_venue_thesis_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 5. Partial index so the queue stays cheap even after years of '
  'done/failed historical rows.';

CREATE INDEX IF NOT EXISTS idx_venue_thesis_jobs_venue
  ON public.venue_thesis_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_venue_thesis_jobs_venue IS
  '24h dedupe lookup: "is there already a queued/running thesis job for '
  'this venue within the last 24h?" Avoids double-spending Sonnet on '
  'milestone bursts.';

-- ============================================================================
-- STEP 3 — cross_venue_overlap (one row per (anchor, peer) pair)
-- ============================================================================
-- At Wedgewood scale (100+ venues), this surfaces shared cohort signals
-- across venue boundaries — at AGGREGATE level only. The peer's couple-
-- level rows are NEVER read; only the peer's venue_thesis aggregate
-- output is compared. Privacy: aggregate ≠ disclose. Never name couples
-- across venue boundaries.

CREATE TABLE IF NOT EXISTS public.cross_venue_overlap (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  peer_venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Structured overlap output. Fields documented in
  -- src/lib/services/intel/onboarding/cross-venue-overlap.ts:
  --   { shared_persona_archetypes, shared_emerging_themes,
  --     shared_service_demand_gaps, shared_voice_principles,
  --     anchor_venue_label, peer_venue_label, computation_notes }
  -- All values are aggregate text labels — no couple-level data.
  overlap_jsonb jsonb NOT NULL,
  -- 0-100 scalar. Higher = more overlap. Computed as a weighted blend of
  -- archetype intersection / theme intersection / gap intersection /
  -- voice intersection. Used by the dashboard to rank peers.
  confidence_0_100 int NOT NULL CHECK (confidence_0_100 BETWEEN 0 AND 100),
  computed_at timestamptz NOT NULL DEFAULT now()
);

-- Anchor / peer must differ. A venue overlapping with itself is a noop.
ALTER TABLE public.cross_venue_overlap
  DROP CONSTRAINT IF EXISTS cross_venue_overlap_distinct_chk;
ALTER TABLE public.cross_venue_overlap
  ADD CONSTRAINT cross_venue_overlap_distinct_chk
  CHECK (anchor_venue_id <> peer_venue_id);

-- One row per (anchor, peer). Re-running overlap computation upserts the
-- existing row rather than appending. The pair is directional: A→B and
-- B→A are separate rows so each anchor sees its own RLS-scoped view.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cross_venue_overlap_pair
  ON public.cross_venue_overlap (anchor_venue_id, peer_venue_id);

COMMENT ON INDEX public.uniq_cross_venue_overlap_pair IS
  'One row per (anchor, peer) directional pair. Regenerating overlap for '
  'an anchor REPLACES the row rather than appending.';

CREATE INDEX IF NOT EXISTS idx_cross_venue_overlap_anchor
  ON public.cross_venue_overlap (anchor_venue_id, computed_at DESC);

COMMENT ON INDEX public.idx_cross_venue_overlap_anchor IS
  'Hot-path: list overlaps for the current venue, newest first. Drives '
  'the cross-venue sidebar on /admin/onboarding/thesis.';

COMMENT ON TABLE public.cross_venue_overlap IS
  'owner:intelligence. Wave 5D cross-venue cohort overlap. One row per '
  '(anchor_venue, peer_venue) directional pair holding the AGGREGATE-'
  'level intersection between anchor and peer venue_thesis outputs. '
  'NEVER reads couple-level data across venue boundaries — only '
  'venue_thesis.thesis. Privacy doctrine: aggregate ≠ disclose. RLS '
  'enforces anchor-only visibility (a venue sees only the rows where it '
  'is the anchor, never rows where it is the peer being compared TO '
  'another venue). Migration 268.';

COMMENT ON COLUMN public.cross_venue_overlap.overlap_jsonb IS
  'Structured aggregate-only overlap output. Contains shared archetype '
  'labels, shared theme labels, shared service-demand gap labels, shared '
  'voice principles. NEVER couple names, NEVER evidence quotes, NEVER '
  'per-couple counts.';

COMMENT ON COLUMN public.cross_venue_overlap.confidence_0_100 IS
  'Weighted blend (archetype 30% / themes 25% / gaps 25% / voice 20%) '
  'of intersection-over-union ratios. Used by the dashboard to rank '
  'peers by similarity.';

-- ============================================================================
-- STEP 4 — RLS
-- ============================================================================
-- venue_thesis: standard venue-scoped pattern (mirror of venue_intel).
-- venue_thesis_jobs: same.
-- cross_venue_overlap: anchor_venue_id-scoped — the user only sees rows
-- where THEIR venue is the anchor. They never see rows where their venue
-- is the peer being compared INTO another venue (that's the other
-- venue's view, not theirs). This is the privacy invariant.

ALTER TABLE public.venue_thesis ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_thesis_auth_select"
  ON public.venue_thesis;
CREATE POLICY "venue_thesis_auth_select"
  ON public.venue_thesis
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- Insert / update reserved for service-role. The thesis writer is the
-- only legitimate writer; no UI ever inserts directly. Mirrors
-- persona_channel_rollups (mig 266).
DROP POLICY IF EXISTS "venue_thesis_auth_insert"
  ON public.venue_thesis;
CREATE POLICY "venue_thesis_auth_insert"
  ON public.venue_thesis
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "venue_thesis_auth_update"
  ON public.venue_thesis;
CREATE POLICY "venue_thesis_auth_update"
  ON public.venue_thesis
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "venue_thesis_auth_delete"
  ON public.venue_thesis;
CREATE POLICY "venue_thesis_auth_delete"
  ON public.venue_thesis
  FOR DELETE
  TO authenticated
  USING (false);

ALTER TABLE public.venue_thesis_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_thesis_jobs_auth_select"
  ON public.venue_thesis_jobs;
CREATE POLICY "venue_thesis_jobs_auth_select"
  ON public.venue_thesis_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_thesis_jobs_auth_insert"
  ON public.venue_thesis_jobs;
CREATE POLICY "venue_thesis_jobs_auth_insert"
  ON public.venue_thesis_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "venue_thesis_jobs_auth_update"
  ON public.venue_thesis_jobs;
CREATE POLICY "venue_thesis_jobs_auth_update"
  ON public.venue_thesis_jobs
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

ALTER TABLE public.cross_venue_overlap ENABLE ROW LEVEL SECURITY;

-- ANCHOR-SCOPED RLS: a venue sees rows where it is the ANCHOR only.
-- It does NOT see rows where it is the peer being compared to another
-- venue. Privacy invariant — peer view leaks the other venue's anchor
-- intent, which is operator-private.
DROP POLICY IF EXISTS "cross_venue_overlap_anchor_select"
  ON public.cross_venue_overlap;
CREATE POLICY "cross_venue_overlap_anchor_select"
  ON public.cross_venue_overlap
  FOR SELECT
  TO authenticated
  USING (
    anchor_venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

-- Writes reserved for service-role (the overlap detector is the only
-- legitimate writer).
DROP POLICY IF EXISTS "cross_venue_overlap_anchor_insert"
  ON public.cross_venue_overlap;
CREATE POLICY "cross_venue_overlap_anchor_insert"
  ON public.cross_venue_overlap
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "cross_venue_overlap_anchor_update"
  ON public.cross_venue_overlap;
CREATE POLICY "cross_venue_overlap_anchor_update"
  ON public.cross_venue_overlap
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "cross_venue_overlap_anchor_delete"
  ON public.cross_venue_overlap;
CREATE POLICY "cross_venue_overlap_anchor_delete"
  ON public.cross_venue_overlap
  FOR DELETE
  TO authenticated
  USING (false);

COMMIT;

NOTIFY pgrst, 'reload schema';
