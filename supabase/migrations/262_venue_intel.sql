-- ---------------------------------------------------------------------------
-- 262_venue_intel.sql
-- ---------------------------------------------------------------------------
-- Wave 5B — per-venue cohort rollup intel layer.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the thesis;
--     Wave 5 derives intel — 5A per-couple, 5B per-cohort/venue, 5C external).
--   - bloom-wave4-5-6-master-plan.md (5B spec: emerging_themes,
--     conversion_correlations, voice_calibration, service_demand_map,
--     timing_patterns; weekly cron; /intel/cohort dashboard; ~$5/venue/week).
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
--     themes report counts at the venue level, never name couples).
--   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
--     must be a real callAI; Wave 5B is a Sonnet aggregator over the
--     per-couple substrate).
--
-- Why this migration exists
-- -------------------------
-- Wave 4 produced the forensic record (WHO each couple is). Wave 5A
-- produced the per-couple action layer (WHAT to do per couple). Wave 5B
-- aggregates across the venue's couples to surface what's emerging,
-- what's converting, what's stuck — at the cohort level. Different
-- LLM job from 4 + 5A: 4 is forensic extraction, 5A is per-couple
-- synthesis, 5B is multi-couple pattern synthesis.
--
-- Storage shape:
--   * one venue_intel row per venue (most-recent rollup),
--   * a venue_intel_jobs queue mirroring the Wave 4 + 5A job pattern
--     (status / trigger_signal / atomic-claim worker model).
--
-- Shape of `rollup`:
--   {
--     "emerging_themes": [
--       { "theme": "...", "trend": "rising"|"steady"|"declining",
--         "evidence_count": int, "evidence_window_days": int,
--         "sensitivity_filtered_count": int, "summary": "..." }
--     ],
--     "conversion_correlations": [
--       { "signal": "...", "outcome": "books"|"drops"|"slow",
--         "lift_pct": number, "n_couples": int,
--         "confidence_0_100": int, "reasoning": "..." }
--     ],
--     "voice_calibration": [
--       { "persona_label": "...",
--         "language_that_lands": ["..."],
--         "language_to_avoid": ["..."],
--         "evidence_summary": "..." }
--     ],
--     "service_demand_map": [
--       { "service_or_offering": "...", "demand_signal": "...",
--         "currently_offered": "yes"|"no"|"unknown",
--         "investment_recommendation": "..." }
--     ],
--     "timing_patterns": [
--       { "pattern": "...", "evidence_summary": "...",
--         "actionable_recommendation": "..." }
--     ],
--     "refusals": [{ "field": "...", "reason": "..." }]
--   }
--
-- Aggregate ≠ disclose. The cohort-rollup prompt enforces the rule:
-- sensitive themes (medical/grief/financial_stress/family_conflict/
-- mental_health) report COUNTS only via sensitivity_filtered_count.
-- The aggregator NEVER names couples and NEVER quotes evidence.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — venue_intel (one row per venue)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.venue_intel (
  venue_id uuid PRIMARY KEY REFERENCES public.venues(id) ON DELETE CASCADE,
  rollup jsonb NOT NULL,
  last_refreshed_at timestamptz NOT NULL DEFAULT now(),
  -- The window aggregated. Default 90 days. Stored on the row so the
  -- coordinator surface can render "last 90d cohort" without rebuilding.
  source_window_days integer NOT NULL DEFAULT 90,
  -- Number of couples whose profile + intel fed into the aggregator.
  couples_in_window integer NOT NULL DEFAULT 0,
  prompt_version text NOT NULL,
  -- Cumulative cost across rollups for this venue. Numeric not integer
  -- because Sonnet cost-per-call is sub-cent on cache hits.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.venue_intel IS
  'owner:agent. Wave 5B per-venue cohort rollup intel. One row per venue '
  'holding the structured Sonnet aggregator output: emerging_themes, '
  'conversion_correlations, voice_calibration, service_demand_map, '
  'timing_patterns. Read by /intel/cohort dashboard + Wave 5C will pipe '
  'voice_calibration into Sage drafts. Refresh trigger: weekly cron + '
  'manual force. Aggregate-not-disclose: sensitive themes report counts '
  'only, never name couples or quote evidence. Cost target $2-5 per '
  'rollup. Migration 262.';

COMMENT ON COLUMN public.venue_intel.rollup IS
  'Structured Sonnet aggregator output. See migration header for the '
  'JSON shape. Sensitive themes (medical/grief/financial_stress/family_'
  'conflict/mental_health) appear as counts (sensitivity_filtered_count) '
  'only — never named couples, never evidence_quote. Coordinator surfaces '
  'gate any deeper reveal on venue_config.feature_flags.reveal_sensitive_'
  'themes.';

COMMENT ON COLUMN public.venue_intel.source_window_days IS
  'Number of trailing days of couples aggregated. Defaults to 90 — long '
  'enough to span an inquiry-to-book median, short enough that emerging '
  'trends remain visible. Operator can override via /api/admin/intel/'
  'cohort-rollup body.windowDays.';

COMMENT ON COLUMN public.venue_intel.couples_in_window IS
  'Couples whose profile + intel fed the aggregator. Hoisted out of '
  'rollup so the freshness card can render "synthesized from 47 couples" '
  'without parsing jsonb. When 0, the surface renders an empty state.';

COMMENT ON COLUMN public.venue_intel.cost_cents IS
  'Cumulative dollar cost (in cents, sub-cent precision) of every rollup '
  'for this venue. Each refresh adds the per-call cost on top of the '
  'existing cumulative. Tracks Wave 5B spend over time.';

CREATE INDEX IF NOT EXISTS idx_venue_intel_venue_refreshed
  ON public.venue_intel (venue_id, last_refreshed_at DESC);

COMMENT ON INDEX public.idx_venue_intel_venue_refreshed IS
  'Drift / freshness index. Cron sweep picks venues whose '
  'last_refreshed_at is older than 7 days and enqueues a refresh job. '
  'Also used by the dashboard to show "last refreshed Nm/h/d ago".';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_venue_intel_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_venue_intel_touch ON public.venue_intel;
CREATE TRIGGER trg_venue_intel_touch
  BEFORE UPDATE ON public.venue_intel
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_venue_intel_updated_at();

-- ============================================================================
-- STEP 2 — venue_intel_jobs (queue table)
-- ============================================================================
-- Same shape as identity_reconstruction_jobs (mig 260) and
-- couple_intel_jobs (mig 261). Per-venue not per-couple, so volume is
-- low (one venue rollup per week per venue). Worker drains via the
-- cron dispatcher.

CREATE TABLE IF NOT EXISTS public.venue_intel_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that produced this enqueue.
  -- Common values: 'weekly_cron' | 'manual_bulk' | 'drift_refresh' |
  -- 'admin_backfill'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.venue_intel_jobs IS
  'owner:agent. Wave 5B cohort rollup queue. Enqueue triggers: (a) the '
  'weekly cohort_rollup_sweep cron fires drift_refresh for any venue '
  'whose last_refreshed_at < 7 days, (b) /api/admin/intel/cohort-rollup-'
  'bulk fires manual_bulk per venue. Worker drains 5 jobs per tick '
  '(volume is per-venue not per-couple, so low). Migration 262.';

COMMENT ON COLUMN public.venue_intel_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label so new triggers can land '
  'without a migration. Common values: weekly_cron | manual_bulk | '
  'drift_refresh | admin_backfill.';

CREATE INDEX IF NOT EXISTS idx_venue_intel_jobs_dequeue
  ON public.venue_intel_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_venue_intel_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 5. Partial index so the queue stays cheap even after years of '
  'done/failed historical rows.';

CREATE INDEX IF NOT EXISTS idx_venue_intel_jobs_venue
  ON public.venue_intel_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_venue_intel_jobs_venue IS
  '24h dedupe lookup: "is there already a queued/running rollup job for '
  'this venue within the last 24h?" Avoids double-spending Sonnet on '
  'manual bursts.';

-- ============================================================================
-- STEP 3 — RLS (mirrors couple_intel pattern, scoped on venue_id)
-- ============================================================================

ALTER TABLE public.venue_intel ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_intel_auth_select"
  ON public.venue_intel;
CREATE POLICY "venue_intel_auth_select"
  ON public.venue_intel
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_intel_auth_insert"
  ON public.venue_intel;
CREATE POLICY "venue_intel_auth_insert"
  ON public.venue_intel
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_intel_auth_update"
  ON public.venue_intel;
CREATE POLICY "venue_intel_auth_update"
  ON public.venue_intel
  FOR UPDATE
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

ALTER TABLE public.venue_intel_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_intel_jobs_auth_select"
  ON public.venue_intel_jobs;
CREATE POLICY "venue_intel_jobs_auth_select"
  ON public.venue_intel_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_intel_jobs_auth_insert"
  ON public.venue_intel_jobs;
CREATE POLICY "venue_intel_jobs_auth_insert"
  ON public.venue_intel_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "venue_intel_jobs_auth_update"
  ON public.venue_intel_jobs;
CREATE POLICY "venue_intel_jobs_auth_update"
  ON public.venue_intel_jobs
  FOR UPDATE
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  )
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

COMMIT;

NOTIFY pgrst, 'reload schema';
