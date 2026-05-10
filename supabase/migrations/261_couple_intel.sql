-- ---------------------------------------------------------------------------
-- 261_couple_intel.sql
-- ---------------------------------------------------------------------------
-- Wave 5A — per-couple derivative intel layer.
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the thesis;
--     Wave 5A is the action layer derived from couple_identity_profile)
--   - bloom-wave4-5-6-master-plan.md (5A: per-couple persona + close-prob
--     + recommended action + coordinator brief + sensitivity flags +
--     stale-signal alerts; refreshed when the underlying profile drifts)
--   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
--     must be backed by a real callAI; Wave 5A is a Sonnet synthesizer
--     derived from the Wave 4 forensic substrate)
--
-- Why this migration exists
-- -------------------------
-- Wave 4 produces couple_identity_profile (WHO each couple is). Wave 5A
-- derives WHAT TO DO per couple. Different LLM job: Wave 4 is forensic
-- extraction; Wave 5A is synthesis + recommendation. Storing the synthesis
-- separately so we can:
--   * sort/triage by predicted_close_probability_pct without rebuilding
--     intel on every page render,
--   * cluster persona_label across cohorts (Wave 5B clustering pass),
--   * detect drift (source_profile_at vs couple_identity_profile.last_
--     reconstructed_at) and trigger refresh.
--
-- Shape of `intel`:
--   {
--     "predicted_close_probability": {
--       "pct_0_100": int,
--       "reasoning": string,
--       "key_signals": [string],
--       "confidence_0_100": int
--     },
--     "persona": {
--       "label": string,        -- discovered from data, not enum
--       "description": string,
--       "confidence_0_100": int
--     },
--     "recommended_next_action": {
--       "action": string,       -- imperative
--       "timing": string,       -- "within 4 hours", etc.
--       "reasoning": string
--     },
--     "coordinator_brief": string,  -- 80-150 words; voice-shape only,
--                                   -- never quotes sensitive evidence
--     "sensitivity_flags": [
--       { "category": string, "handle_with": string }
--     ],
--     "stale_signal_alerts": [
--       { "signal": string, "since": string, "suggested_action": string }
--     ],
--     "refusals": [{ "field": string, "reason": string }]
--   }
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — couple_intel (one row per wedding)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.couple_intel (
  wedding_id uuid PRIMARY KEY REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  intel jsonb NOT NULL,
  -- Hot columns hoisted out of jsonb for cheap sort/group queries.
  predicted_close_probability_pct integer
    CHECK (predicted_close_probability_pct IS NULL
      OR (predicted_close_probability_pct BETWEEN 0 AND 100)),
  persona_label text,
  last_derived_at timestamptz NOT NULL DEFAULT now(),
  -- Snapshot of couple_identity_profile.last_reconstructed_at at the
  -- time this intel was derived. Drift detector compares against the
  -- live value so we know when the underlying profile has moved.
  source_profile_at timestamptz,
  derive_count integer NOT NULL DEFAULT 1,
  prompt_version text NOT NULL,
  -- Cumulative cost in cents (sub-cent precision). Each derive adds the
  -- per-call cost from callAI on top of the existing cumulative.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.couple_intel IS
  'owner:agent. Wave 5A per-couple derivative intel. One row per wedding '
  'holding the structured Sonnet synthesis: predicted close probability, '
  'persona label (discovered from data, not enum), recommended next '
  'action, coordinator brief (~80-150 words), sensitivity flags, and '
  'stale-signal alerts. Read by the lead detail page CoupleIntelPanel + '
  'inbox triage (Wave 5B). Refresh trigger: a fresh '
  'couple_identity_profile reconstruction enqueues an intel refresh; '
  'drift sweep also picks up profiles whose last_derived_at is older '
  'than 7d. Cost target $0.02 per derive. Migration 261.';

COMMENT ON COLUMN public.couple_intel.intel IS
  'Structured Sonnet synthesis. See migration header for the JSON shape. '
  'Voice-shape only — coordinator_brief NEVER quotes sensitive evidence '
  'verbatim. Sensitivity flags carry category + handle_with coaching '
  'pulled from profile.emotional_truths where sensitive=true; the '
  'evidence_quote stays in couple_identity_profile and is gated by '
  'venue_config.feature_flags.reveal_sensitive_themes.';

COMMENT ON COLUMN public.couple_intel.predicted_close_probability_pct IS
  'Hoisted out of intel.predicted_close_probability.pct_0_100 for cheap '
  'venue-scoped triage queries (sort hot leads desc, etc.). Indexed.';

COMMENT ON COLUMN public.couple_intel.persona_label IS
  'Hoisted out of intel.persona.label for cheap GROUP BY rollups. '
  'Discovered by the LLM, not an enum — Wave 5B will cluster these into '
  'cohort rollups when the label distribution stabilises.';

COMMENT ON COLUMN public.couple_intel.source_profile_at IS
  'couple_identity_profile.last_reconstructed_at at derive time. Drift '
  'detector: when profile.last_reconstructed_at > intel.source_profile_at, '
  'the underlying forensic record has moved and intel should refresh.';

COMMENT ON COLUMN public.couple_intel.derive_count IS
  'Total times this intel has been re-derived. Increments on every '
  'upsert. Same audit pattern as couple_identity_profile.reconstruction_'
  'count.';

COMMENT ON COLUMN public.couple_intel.cost_cents IS
  'Cumulative dollar cost (in cents, sub-cent precision) of every derive '
  'for this wedding. Numeric not integer because Sonnet cost-per-call is '
  'sub-cent on cache hits.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_venue_close_prob
  ON public.couple_intel (venue_id, predicted_close_probability_pct DESC);

COMMENT ON INDEX public.idx_couple_intel_venue_close_prob IS
  'Hot-path index for venue-scoped close-probability sort: "show me the '
  'top-N hottest predicted closes" (lead triage), inbox sort by predicted '
  'closeability, etc.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_venue_persona
  ON public.couple_intel (venue_id, persona_label);

COMMENT ON INDEX public.idx_couple_intel_venue_persona IS
  'Persona rollup index: "how many of each persona does this venue have?" '
  '(GROUP BY persona_label). Wave 5B uses this for cohort feeds + '
  'persona x channel ROI rollups in Wave 6.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_venue_recent
  ON public.couple_intel (venue_id, last_derived_at DESC);

COMMENT ON INDEX public.idx_couple_intel_venue_recent IS
  'Drift / freshness index. Cron sweep picks N stalest derives per tick.';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_couple_intel_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_couple_intel_touch ON public.couple_intel;
CREATE TRIGGER trg_couple_intel_touch
  BEFORE UPDATE ON public.couple_intel
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_couple_intel_updated_at();

-- ============================================================================
-- STEP 2 — couple_intel_jobs (queue table)
-- ============================================================================
-- Same shape as identity_reconstruction_jobs (mig 260). 24h dedupe at the
-- enqueue layer. Worker drains via the cron dispatcher
-- (/api/cron?job=couple_intel_sweep) every 10 minutes.

CREATE TABLE IF NOT EXISTS public.couple_intel_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wedding_id uuid NOT NULL REFERENCES public.weddings(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that produced this enqueue. Examples:
  -- 'profile_updated' (fired from reconstruct.ts after the profile
  -- upsert), 'manual_bulk', 'drift_refresh', 'admin_backfill'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.couple_intel_jobs IS
  'owner:agent. Wave 5A intel-derive queue. Enqueue triggers: (a) Wave '
  '4 reconstruct.ts fires "profile_updated" after every profile upsert, '
  '(b) /api/admin/intel/couple-derive-bulk fires "manual_bulk" per '
  'paged wedding, (c) couple_intel_sweep cron fires "drift_refresh" '
  'for derives older than 7d. 24h dedupe per wedding at the enqueue '
  'layer. Worker drains 50 jobs per tick + drift refresh of 5. '
  'Migration 261.';

COMMENT ON COLUMN public.couple_intel_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text label so new triggers can land '
  'without a migration. Common values: profile_updated | manual_bulk | '
  'drift_refresh | admin_backfill.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_jobs_dequeue
  ON public.couple_intel_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_couple_intel_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 50. Partial index so the queue stays cheap even after millions '
  'of done/failed/skipped historical rows.';

CREATE INDEX IF NOT EXISTS idx_couple_intel_jobs_wedding
  ON public.couple_intel_jobs (wedding_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_couple_intel_jobs_wedding IS
  '24h dedupe lookup: "is there already a queued/running job for this '
  'wedding within the last 24h?" Avoids double-spending Sonnet on '
  'profile-update bursts.';

-- ============================================================================
-- STEP 3 — RLS (mirrors couple_identity_profile pattern)
-- ============================================================================

ALTER TABLE public.couple_intel ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple_intel_auth_select"
  ON public.couple_intel;
CREATE POLICY "couple_intel_auth_select"
  ON public.couple_intel
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_intel_auth_insert"
  ON public.couple_intel;
CREATE POLICY "couple_intel_auth_insert"
  ON public.couple_intel
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_intel_auth_update"
  ON public.couple_intel;
CREATE POLICY "couple_intel_auth_update"
  ON public.couple_intel
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

ALTER TABLE public.couple_intel_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "couple_intel_jobs_auth_select"
  ON public.couple_intel_jobs;
CREATE POLICY "couple_intel_jobs_auth_select"
  ON public.couple_intel_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_intel_jobs_auth_insert"
  ON public.couple_intel_jobs;
CREATE POLICY "couple_intel_jobs_auth_insert"
  ON public.couple_intel_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "couple_intel_jobs_auth_update"
  ON public.couple_intel_jobs;
CREATE POLICY "couple_intel_jobs_auth_update"
  ON public.couple_intel_jobs
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
