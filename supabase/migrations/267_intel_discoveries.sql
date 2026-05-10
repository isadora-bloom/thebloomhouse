-- ---------------------------------------------------------------------------
-- 267_intel_discoveries.sql
-- ---------------------------------------------------------------------------
-- Wave 7A — pattern discovery engine (the unknown-unknowns hunter).
--
-- Anchor docs:
--   - bloom-constitution.md (forensic identity reconstruction is the thesis;
--     Wave 7A is THE differentiator vs every other CRM — it tells the
--     operator what they DON'T know, not what they do).
--   - bloom-wave4-5-6-master-plan.md (Wave 7A spec — discovery, not
--     classification. Free-form output. The LLM invents the hypothesis
--     category instead of filling a pre-defined bucket).
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The discovery
--     engine sees ANONYMISED rollups only — never names couples).
--   - feedback_parallel_stream_safety.md (migration 267 is pre-allocated
--     for Wave 7A; Wave 5D owns 268, Wave 6C owns 269).
--
-- Why this migration exists (and why it's structurally different from 5/6)
-- ------------------------------------------------------------------------
-- Wave 4 reconstructs WHO each couple is. Wave 5 derives PER-COUPLE,
-- COHORT, and EXTERNAL-MATCH intel inside pre-defined buckets. Wave 6
-- closes the marketing-ROI loop along persona × channel × revenue cells
-- the schema fixes upfront.
--
-- Wave 7A is a different KIND of LLM job. The seed prompts (channel-role
-- distortion, vendor referrals not formally tracked, persona × channel
-- patterns, stale-but-warm leads, booking-blocker questions, time-of-day
-- inquiry patterns, cross-platform identity drift, competitor positioning,
-- demographic clustering, conversion-rate disparity) are EXAMPLES — not
-- an enum. The LLM is given freedom to invent the hypothesis_category
-- because the whole point is hunting for things the operator (and the
-- schema designers) don't know to look for.
--
-- Storage shape:
--   * intel_discoveries — one row per discovered hypothesis. New runs
--     INSERT new rows (audit history); a follow-up dedupe pass may merge
--     near-duplicate titles in the same recent window — that's a Wave 7A
--     follow-up, not blocking.
--   * intel_discovery_jobs — queue table, mirrors intel_match_jobs.
--
-- Idempotent: every CREATE TABLE / INDEX / POLICY uses IF NOT EXISTS or
-- DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — intel_discoveries (one row per discovered hypothesis)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intel_discoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Short headline ("Knot may be a validation channel for 30% of leads").
  -- Capped at 200 chars; the prompt asks for < 80 but we leave headroom.
  hypothesis_title text NOT NULL,
  -- Full hypothesis paragraph. Free-form prose explaining the pattern,
  -- the evidence, and what the operator should consider testing.
  hypothesis_text text NOT NULL,
  -- LLM-INVENTED category, free-form. Examples (NOT enforced):
  --   'channel_role_distortion'
  --   'vendor_referral_unobserved'
  --   'persona_channel_pattern'
  --   'stale_warm_lead'
  --   'booking_blocker_question'
  --   'time_of_day_pattern'
  --   'cross_platform_drift'
  --   'competitor_positioning'
  --   'demographic_clustering'
  --   'conversion_rate_disparity'
  -- The whole point of Wave 7A is the LLM may invent a NEW category we
  -- haven't anticipated. NEVER make this an enum or CHECK constraint.
  hypothesis_category text NOT NULL,
  -- Structured evidence chain — the LLM decides the shape based on the
  -- hypothesis, but we ALWAYS expect:
  --   { signal_type, n_couples, n_evidence_points, aggregate_stats: {...},
  --     key_observations: [string] }
  -- Aggregate ≠ disclose: NEVER includes couple names. Only sample IDs
  -- (hashed or never present), persona-level shares, theme-level counts,
  -- etc.
  evidence_summary jsonb NOT NULL,
  -- LLM's proposed validation test (Wave 7C will execute this).
  recommended_test text,
  -- LLM's proposed action when the test validates the hypothesis.
  -- The operator decides whether to run the action; Wave 7A NEVER auto-
  -- executes anything.
  recommended_action_if_validated text,
  -- 0-100 confidence based on the strength of the evidence chain.
  confidence_0_100 integer NOT NULL CHECK (
    confidence_0_100 >= 0 AND confidence_0_100 <= 100
  ),
  -- Triage state machine. Default 'pending' on insert. Wave 7C populates
  -- 'in_progress' / 'validated' / 'refuted'. Coordinator can dismiss
  -- directly without running the test.
  validation_status text NOT NULL DEFAULT 'pending' CHECK (
    validation_status IN ('pending', 'in_progress', 'validated', 'refuted', 'dismissed')
  ),
  -- Wave 7C populates these after running the test.
  validation_result_summary text,
  -- { p_value, lift, confidence_interval, n }
  validation_metric jsonb,
  validated_at timestamptz,
  -- Coordinator dismissal triage.
  dismissed_at timestamptz,
  dismissed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dismissal_reason text,
  -- When the operator records that they took an action based on this
  -- discovery (independent of validation — sometimes a hypothesis is
  -- compelling enough to act on without a formal test).
  actioned_at timestamptz,
  action_taken text,
  -- Prompt version threaded into api_costs.prompt_version for regression
  -- audits.
  prompt_version text NOT NULL,
  -- Cost in cents (numeric to keep cents-and-fractions precision; matches
  -- venue_intel.cost_cents pattern).
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.intel_discoveries IS
  'owner:agent. Wave 7A pattern discovery engine output. One row per '
  'discovered hypothesis. hypothesis_category is FREE-FORM (LLM-invented) '
  'by design — Wave 7A hunts for unknown-unknowns, so the schema must not '
  'pre-define the categories. evidence_summary is anonymised aggregate '
  'evidence; NEVER contains couple names. validation_status moves from '
  'pending → in_progress → validated/refuted (via Wave 7C) or dismissed '
  '(coordinator triage). New runs INSERT new rows — preserve audit '
  'history. Migration 267.';

COMMENT ON COLUMN public.intel_discoveries.hypothesis_category IS
  'LLM-invented free-form category. Examples in master prompt include '
  'channel_role_distortion, vendor_referral_unobserved, persona_channel_'
  'pattern, stale_warm_lead, booking_blocker_question, time_of_day_'
  'pattern, cross_platform_drift, competitor_positioning. NOT an enum. '
  'The LLM may invent a brand-new category to capture a pattern we '
  'haven''t anticipated — that is the entire point of Wave 7A.';

COMMENT ON COLUMN public.intel_discoveries.evidence_summary IS
  'Anonymised aggregate evidence chain. Standard shape: { signal_type, '
  'n_couples, n_evidence_points, aggregate_stats: {...}, key_observations: '
  '[string] }. Aggregate ≠ disclose — NEVER name couples. Sample IDs are '
  'hashed or omitted; persona-level shares + theme-level counts are the '
  'safe surface.';

COMMENT ON COLUMN public.intel_discoveries.recommended_test IS
  'LLM''s proposed validation test. Wave 7C executes this; Wave 7A only '
  'authors it. Common shape: cohort comparison + statistical lift target.';

COMMENT ON COLUMN public.intel_discoveries.validation_status IS
  'pending (initial) | in_progress (Wave 7C is running the test) | '
  'validated | refuted | dismissed (coordinator triaged without testing). '
  'Validated discoveries feed back into Wave 5/6 as new buckets — Wave 7D '
  'closes that loop.';

-- Active discoveries index. Most-common dashboard query: pending
-- discoveries newest-first per venue.
CREATE INDEX IF NOT EXISTS idx_intel_discoveries_active_recent
  ON public.intel_discoveries (venue_id, validation_status, created_at DESC);

COMMENT ON INDEX public.idx_intel_discoveries_active_recent IS
  'Dashboard list: discoveries grouped by validation_status, newest first.';

-- Per-category slice. Dashboard groups visually by hypothesis_category
-- so coordinators can scan a wall of patterns by type.
CREATE INDEX IF NOT EXISTS idx_intel_discoveries_by_category
  ON public.intel_discoveries (venue_id, hypothesis_category);

COMMENT ON INDEX public.idx_intel_discoveries_by_category IS
  'Per-category visual grouping for the discoveries dashboard.';

-- Validation feedback loop. Wave 7D queries validated discoveries to
-- promote them into new Wave 5/6 buckets.
CREATE INDEX IF NOT EXISTS idx_intel_discoveries_validated
  ON public.intel_discoveries (venue_id, validated_at DESC)
  WHERE validation_status = 'validated';

COMMENT ON INDEX public.idx_intel_discoveries_validated IS
  'Feedback loop: Wave 7D promotes validated discoveries to new Wave 5/6 '
  'buckets / correlations / attribution rules.';

-- updated_at trigger.
CREATE OR REPLACE FUNCTION public.touch_intel_discoveries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_intel_discoveries_touch ON public.intel_discoveries;
CREATE TRIGGER trg_intel_discoveries_touch
  BEFORE UPDATE ON public.intel_discoveries
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_intel_discoveries_updated_at();

-- ============================================================================
-- STEP 2 — intel_discovery_jobs (queue table — mirrors intel_match_jobs)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.intel_discovery_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.intel_discovery_jobs IS
  'owner:agent. Wave 7A discovery-engine queue. Enqueue triggers: '
  '(a) couple_intel volume threshold (e.g. every 25 new derives per '
  'venue, see TODO_TRIGGER in enqueue.ts); (b) drift_refresh from '
  'discovery_engine_sweep cron, weekly; (c) admin_backfill via /api/admin/'
  'intel/discoveries/run with force=true. Worker drains 3 jobs per tick '
  '(Sonnet calls are expensive — pacing matters). Migration 267.';

COMMENT ON COLUMN public.intel_discovery_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text: volume_threshold | drift_refresh | '
  'admin_backfill | manual_force.';

CREATE INDEX IF NOT EXISTS idx_intel_discovery_jobs_dequeue
  ON public.intel_discovery_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_intel_discovery_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=queued LIMIT 3.';

CREATE INDEX IF NOT EXISTS idx_intel_discovery_jobs_venue
  ON public.intel_discovery_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_intel_discovery_jobs_venue IS
  'Per-venue 24h dedupe lookup. Mirrors Wave 4/5A/5B/5C queue patterns.';

-- ============================================================================
-- STEP 3 — RLS (mirrors intel_matches pattern, scoped on venue_id)
-- ============================================================================

ALTER TABLE public.intel_discoveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_discoveries_auth_select"
  ON public.intel_discoveries;
CREATE POLICY "intel_discoveries_auth_select"
  ON public.intel_discoveries
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_discoveries_auth_insert"
  ON public.intel_discoveries;
CREATE POLICY "intel_discoveries_auth_insert"
  ON public.intel_discoveries
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_discoveries_auth_update"
  ON public.intel_discoveries;
CREATE POLICY "intel_discoveries_auth_update"
  ON public.intel_discoveries
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

ALTER TABLE public.intel_discovery_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "intel_discovery_jobs_auth_select"
  ON public.intel_discovery_jobs;
CREATE POLICY "intel_discovery_jobs_auth_select"
  ON public.intel_discovery_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_discovery_jobs_auth_insert"
  ON public.intel_discovery_jobs;
CREATE POLICY "intel_discovery_jobs_auth_insert"
  ON public.intel_discovery_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "intel_discovery_jobs_auth_update"
  ON public.intel_discovery_jobs;
CREATE POLICY "intel_discovery_jobs_auth_update"
  ON public.intel_discovery_jobs
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
