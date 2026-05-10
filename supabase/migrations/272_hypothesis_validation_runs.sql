-- ---------------------------------------------------------------------------
-- 272_hypothesis_validation_runs.sql
-- ---------------------------------------------------------------------------
-- Wave 7C — hypothesis validation engine. Closes the discovery feedback loop.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 7 closes the forensic loop. Wave 7A
--     hunts for unknown-unknowns; Wave 7C designs and runs the test that
--     confirms or refutes each hypothesis. Validated discoveries feed
--     BACK into Wave 5/6 as new buckets — Wave 7D closes that loop.)
--   - bloom-wave4-5-6-master-plan.md (Wave 7C spec: two Sonnet calls per
--     run — test designer + result interpreter. Coordinator confirms.)
--   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. The validator
--     sees ANONYMISED rollups + cohort filter shapes only — never names
--     couples.)
--   - feedback_parallel_stream_safety.md (Wave 7C is on migration 272.
--     Wave 6D=273. Wave 8=271. We MAY add validation-tracking columns to
--     intel_discoveries, never restructure existing columns.)
--
-- Why this migration exists
-- -------------------------
-- Wave 7A produces hypotheses with a free-text `recommended_test` field
-- but no execution. Wave 7C is the engine that designs the actual test
-- (Sonnet 1: test designer outputs structured comparison logic), runs
-- it against the venue's anonymised cohort data, returns a result with
-- statistical confidence (Sonnet 2: result interpreter labels it as
-- validated / refuted / inconclusive / data_too_thin).
--
-- Storage shape:
--   * ALTER intel_discoveries — add validation_started_at,
--     validation_completed_at, validation_test_plan jsonb,
--     validation_runs_count int. Existing columns untouched.
--   * hypothesis_validation_runs — one row per validation attempt. We
--     preserve audit history so a coordinator can see "this hypothesis
--     was tested 3 times across 6 weeks; the result flipped from
--     inconclusive to validated when the cohort grew past n=20."
--   * hypothesis_validation_jobs — queue table. Mirrors
--     intel_discovery_jobs / intel_match_jobs.
--
-- Idempotent: every CREATE / ALTER / INDEX / POLICY uses IF NOT EXISTS
-- or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — extend intel_discoveries with validation tracking columns
-- ============================================================================

ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS validation_started_at timestamptz;

ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS validation_completed_at timestamptz;

-- The test plan Sonnet (designer call) emitted on the most recent run.
-- Free-form jsonb because validation tests are themselves discovery-shaped:
-- common patterns are cohort_comparison + time_shift + channel_comparison
-- but Wave 7A may produce hypotheses whose tests don't fit any of those.
-- Standard shape (test executor expects this when present):
--   { test_kind, treatment_cohort_filter: {...}, control_cohort_filter: {...},
--     metric, direction_if_confirmed, minimum_n, statistical_test,
--     expected_lift_threshold_pct }
ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS validation_test_plan jsonb;

-- Counter so the dashboard can display "validated 3× over 6 weeks". Bumped
-- by each completed run; never decremented.
ALTER TABLE public.intel_discoveries
  ADD COLUMN IF NOT EXISTS validation_runs_count int NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.intel_discoveries.validation_started_at IS
  'Wave 7C (mig 272). Set when Wave 7C starts a validation run; cleared '
  'when complete. NULL = no run in flight. Used to detect stuck runs '
  '(started > 5 min ago, no completed_at).';

COMMENT ON COLUMN public.intel_discoveries.validation_completed_at IS
  'Wave 7C (mig 272). Set when the most recent validation run finished '
  '(success or failure). Together with validation_runs_count, drives the '
  'dashboard "last validated X minutes ago" badge.';

COMMENT ON COLUMN public.intel_discoveries.validation_test_plan IS
  'Wave 7C (mig 272). Most recent test plan emitted by the Sonnet test '
  'designer. Standard shape (when test executor recognised the kind): '
  '{ test_kind, treatment_cohort_filter, control_cohort_filter, metric, '
  'direction_if_confirmed, minimum_n, statistical_test, '
  'expected_lift_threshold_pct }. Free-form jsonb because Wave 7A may '
  'discover hypotheses whose tests do not fit any pre-defined kind.';

COMMENT ON COLUMN public.intel_discoveries.validation_runs_count IS
  'Wave 7C (mig 272). Total completed validation runs. Bumped per '
  'hypothesis_validation_runs row (success or refute). Drives the '
  'dashboard "tested 3× over 6 weeks" badge.';

-- ============================================================================
-- STEP 2 — hypothesis_validation_runs (one row per validation attempt)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.hypothesis_validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ON DELETE CASCADE so dropping a discovery removes its validation
  -- audit. The discovery is the primary entity; runs are derived.
  discovery_id uuid NOT NULL
    REFERENCES public.intel_discoveries(id) ON DELETE CASCADE,
  -- Denormalised venue_id so RLS + per-venue indexes don't require a
  -- join through intel_discoveries on every read.
  venue_id uuid NOT NULL
    REFERENCES public.venues(id) ON DELETE CASCADE,
  -- The structured test plan Sonnet (designer call) emitted. Standard
  -- shape (when test executor recognised the kind): see comment on
  -- intel_discoveries.validation_test_plan above. Free-form jsonb.
  test_plan jsonb NOT NULL,
  -- The actual numbers from the test executor. Standard shape:
  --   { metric_value_treatment, metric_value_control, lift_pct,
  --     n_treatment, n_control, p_value_approx, statistical_test_used,
  --     errors: [string] }
  test_result jsonb NOT NULL,
  -- Sonnet (interpreter call) categorical interpretation.
  interpretation text NOT NULL CHECK (interpretation IN (
    'validated',
    'refuted',
    'inconclusive',
    'data_too_thin'
  )),
  confidence_0_100 integer NOT NULL CHECK (
    confidence_0_100 >= 0 AND confidence_0_100 <= 100
  ),
  -- Sonnet's reasoning chain explaining why the test plan + numbers led
  -- to the interpretation it picked.
  reasoning text,
  -- Cost in cents (sum of designer + interpreter Sonnet calls). Numeric
  -- to keep cents-and-fractions precision; matches venue_intel /
  -- intel_discoveries.
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  -- Threaded into api_costs.prompt_version for regression audits.
  prompt_version text NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.hypothesis_validation_runs IS
  'owner:agent. Wave 7C hypothesis validation audit log. One row per '
  'validation attempt against an intel_discovery. Preserves history of '
  'multiple validation runs (e.g. inconclusive → validated as cohort '
  'grew). interpretation = validated | refuted | inconclusive | '
  'data_too_thin. test_plan + test_result are anonymised aggregate '
  'shapes; NEVER contain couple names. Migration 272.';

COMMENT ON COLUMN public.hypothesis_validation_runs.test_plan IS
  'Wave 7C (mig 272). The structured test plan Sonnet test designer '
  'emitted. Standard shape: { test_kind, treatment_cohort_filter, '
  'control_cohort_filter, metric, direction_if_confirmed, minimum_n, '
  'statistical_test, expected_lift_threshold_pct }. Free-form because '
  'Wave 7A may discover hypothesis types whose tests do not fit a '
  'pre-defined shape — that is the design.';

COMMENT ON COLUMN public.hypothesis_validation_runs.test_result IS
  'Wave 7C (mig 272). The actual numbers from the test executor. '
  'Standard shape: { metric_value_treatment, metric_value_control, '
  'lift_pct, n_treatment, n_control, p_value_approx, '
  'statistical_test_used, errors: [string] }. Aggregate ≠ disclose; '
  'NEVER contains per-couple data.';

COMMENT ON COLUMN public.hypothesis_validation_runs.interpretation IS
  'Wave 7C (mig 272). Sonnet interpreter categorical verdict. '
  'data_too_thin = not enough cohort data for the test (e.g. n_treatment '
  '< minimum_n). inconclusive = ran but result not statistically clear. '
  'validated = result confirms hypothesis direction at confidence. '
  'refuted = result contradicts hypothesis direction.';

-- Per-discovery audit-history scan: most recent run first.
CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_runs_discovery
  ON public.hypothesis_validation_runs (discovery_id, run_at DESC);

COMMENT ON INDEX public.idx_hypothesis_validation_runs_discovery IS
  'Per-discovery audit history. Drives /api/admin/intel/discoveries/{id}/'
  'validation-result (most recent first) + the dashboard run-history '
  'panel.';

-- Per-venue verdict slice: drives the validated-discoveries feedback
-- loop into Wave 5/6 (Wave 7D reads this).
CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_runs_venue_interpretation
  ON public.hypothesis_validation_runs (venue_id, interpretation);

COMMENT ON INDEX public.idx_hypothesis_validation_runs_venue_interpretation IS
  'Wave 7D feedback loop: pull venue-scoped validated runs to promote '
  'their hypotheses into Wave 5/6 buckets / correlations / attribution '
  'rules.';

-- ============================================================================
-- STEP 3 — hypothesis_validation_jobs (queue table)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.hypothesis_validation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL
    REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Discovery to validate. ON DELETE CASCADE so removing a discovery
  -- removes its queued validation job.
  discovery_id uuid NOT NULL
    REFERENCES public.intel_discoveries(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text
);

COMMENT ON TABLE public.hypothesis_validation_jobs IS
  'owner:agent. Wave 7C hypothesis-validation queue. Enqueue triggers: '
  '(a) new high-confidence discovery (confidence >= 70) when '
  'venue_config opts in (TODO — see enqueue helper); (b) drift_refresh '
  'from hypothesis_validation_sweep cron, weekly, for ''in_progress'' '
  'rows older than 7 days; (c) admin_backfill via /api/admin/intel/'
  'discoveries/{id}/validate. Worker drains 3 jobs per tick (two '
  'Sonnet calls each — pacing matters). Migration 272.';

COMMENT ON COLUMN public.hypothesis_validation_jobs.trigger_signal IS
  'What kicked this enqueue. Free-text: high_confidence_discovery | '
  'drift_refresh | admin_backfill | manual_force.';

CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_jobs_dequeue
  ON public.hypothesis_validation_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_hypothesis_validation_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=queued LIMIT 3.';

CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_jobs_venue
  ON public.hypothesis_validation_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_hypothesis_validation_jobs_venue IS
  'Per-venue 24h dedupe lookup. Mirrors Wave 7A queue pattern.';

CREATE INDEX IF NOT EXISTS idx_hypothesis_validation_jobs_discovery
  ON public.hypothesis_validation_jobs (discovery_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_hypothesis_validation_jobs_discovery IS
  'Per-discovery dedupe: do not enqueue a second job for the same '
  'discovery while one is queued/running.';

-- ============================================================================
-- STEP 4 — RLS (mirrors intel_discoveries pattern, scoped on venue_id)
-- ============================================================================

ALTER TABLE public.hypothesis_validation_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hypothesis_validation_runs_auth_select"
  ON public.hypothesis_validation_runs;
CREATE POLICY "hypothesis_validation_runs_auth_select"
  ON public.hypothesis_validation_runs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "hypothesis_validation_runs_auth_insert"
  ON public.hypothesis_validation_runs;
CREATE POLICY "hypothesis_validation_runs_auth_insert"
  ON public.hypothesis_validation_runs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "hypothesis_validation_runs_auth_update"
  ON public.hypothesis_validation_runs;
CREATE POLICY "hypothesis_validation_runs_auth_update"
  ON public.hypothesis_validation_runs
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

ALTER TABLE public.hypothesis_validation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "hypothesis_validation_jobs_auth_select"
  ON public.hypothesis_validation_jobs;
CREATE POLICY "hypothesis_validation_jobs_auth_select"
  ON public.hypothesis_validation_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "hypothesis_validation_jobs_auth_insert"
  ON public.hypothesis_validation_jobs;
CREATE POLICY "hypothesis_validation_jobs_auth_insert"
  ON public.hypothesis_validation_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "hypothesis_validation_jobs_auth_update"
  ON public.hypothesis_validation_jobs;
CREATE POLICY "hypothesis_validation_jobs_auth_update"
  ON public.hypothesis_validation_jobs
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
