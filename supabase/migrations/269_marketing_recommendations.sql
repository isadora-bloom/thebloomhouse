-- ---------------------------------------------------------------------------
-- 269_marketing_recommendations.sql
-- ---------------------------------------------------------------------------
-- Wave 6C — marketing reallocation recommendations.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 6 closes the forensic loop. Wave 6B
--     produces the persona × channel × ROI matrix; Wave 6C turns it into
--     actionable reallocation recommendations a coordinator can act on.)
--   - bloom-wave4-5-6-master-plan.md (Wave 6C spec: Sonnet recommendation
--     job reads (rollups + cohort intel + external signals) and outputs
--     specific reallocation moves with reasoning chain + confidence +
--     counterfactual.)
--   - feedback_parallel_stream_safety.md (Wave 6C holds migration 269;
--     Wave 7A holds 267, Wave 5D holds 268. We don't write into anyone
--     else's lane and we don't touch their writer code.)
--
-- Why this migration exists
-- -------------------------
-- Without explicit recommendations, the operator has to read the heatmap
-- and self-diagnose what to do. With recommendations, the system says
-- "Move 30% of Knot spend ($800/mo) to Instagram. Knot brings Heritage-
-- Forward at $180 CAC, you book 8%; Instagram brings Heritage-Forward at
-- $90 CAC, 22% conversion. Projected: +$14k/yr." Each recommendation
-- carries a reasoning chain, a counterfactual ("what happens if we DON'T
-- reallocate"), a payback timeline, and confidence — so the coordinator
-- can audit the math, not just the verdict.
--
-- Doctrine
-- --------
-- Recommendations are FLAG-DON'T-EXECUTE. The system never auto-spends.
-- Status defaults to 'pending'; coordinator decides accept / decline /
-- in-progress; the optional measure-after step lets the operator track
-- whether the projected impact actually showed up.
--
-- Cohort threshold
-- ----------------
-- n_too_small_warning fires when the source or target cell underlying
-- the recommendation has < 10 weddings. The LLM's job is to refuse such
-- cases explicitly; the boolean column is the belt-and-suspenders flag
-- the dashboard uses to soft-warn even when the LLM tried to recommend.
--
-- Idempotent: every CREATE TABLE / CREATE INDEX / CREATE POLICY uses
-- IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — marketing_recommendations (one row per recommendation)
-- ============================================================================
-- Each generation pass produces 3-5 rows. Re-running on unchanged input
-- (same input_data_hash) is short-circuited at the service layer — last
-- week's recommendation stands. Re-running with new data inserts new
-- rows; old rows stay (audit trail of the system's evolving advice).

CREATE TABLE IF NOT EXISTS public.marketing_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Short headline ("Move 30% of Knot spend to Instagram"). < 80 chars
  -- recommended; the LLM is asked to keep it tight enough to use as a
  -- card title.
  recommendation_title text NOT NULL,

  -- Full reasoning paragraph. The "story" the operator reads first
  -- before drilling into reasoning_chain.
  recommendation_text text NOT NULL,

  -- Drives card visuals (arrow, badge color) on the dashboard.
  --   reallocate  — move spend from source_channel → target_channel
  --   pause       — stop spending on source_channel
  --   scale       — increase spend on target_channel
  --   investigate — data quality issue or anomaly that needs a human
  --   other       — anything else (let LLM be honest about the shape)
  action_type text NOT NULL
    CHECK (action_type IN ('reallocate', 'pause', 'scale', 'investigate', 'other')),

  -- Channels the recommendation references. NULL when the
  -- recommendation isn't about a specific channel pair (e.g. an
  -- 'investigate' recommendation about untagged personas).
  source_channel text,
  target_channel text,

  -- The persona this recommendation centers on. NULL when the
  -- recommendation is channel-level only (cross-persona generalisation).
  target_persona text,

  -- Projected revenue lift in cents per month. SIGNED:
  --   positive — expected upside (scale, reallocate to better cell)
  --   negative — expected downside the operator absorbs (pause cost
  --              reduction is positive; pause revenue loss would be a
  --              negative number on a different rec)
  -- Cents not dollars to match the rest of the platform.
  estimated_monthly_dollar_impact_cents int,

  confidence_0_100 int NOT NULL CHECK (confidence_0_100 BETWEEN 0 AND 100),

  -- Structured reasoning chain. Required keys:
  --   evidence_signals: [string] — specific cell numbers cited
  --   assumed_baseline: string  — what the rec assumes "today" looks like
  --   projected_outcome: string — what the rec predicts post-action
  --   counterfactual: string    — what happens if we DON'T act
  --   payback_months: number    — how long until impact materialises
  --   key_risks: [string]       — what could falsify the projection
  reasoning_chain jsonb NOT NULL,

  -- Hash of (rollups + cohort_intel + external signals) input. Lets the
  -- service layer short-circuit "input hasn't changed → last week's
  -- recommendation stands".
  input_data_hash text NOT NULL,

  -- Belt-and-suspenders flag for "the source cohort underlying this
  -- recommendation has < 10 weddings". Drives the soft-warn chip on the
  -- dashboard even when the LLM produced a confident-sounding rec.
  n_too_small_warning boolean NOT NULL DEFAULT false,

  generated_at timestamptz NOT NULL DEFAULT now(),

  -- Lifecycle:
  --   pending      — newly generated, awaiting coordinator decision
  --   accepted     — coordinator approved (next state: in_progress)
  --   declined     — coordinator rejected (terminal)
  --   in_progress  — accepted + operator is implementing
  --   completed    — implementation done; measured_outcome may be set
  --   invalidated  — superseded by newer data; auto-set when re-gen
  --                  produces a contradicting rec
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN (
      'pending', 'accepted', 'declined', 'in_progress', 'completed', 'invalidated'
    )),

  decided_at timestamptz,
  decided_by uuid REFERENCES auth.users(id),
  decision_note text,
  actioned_at timestamptz,

  -- Post-action measurement. Operator records actual outcome here so
  -- the system can compare projected vs measured and tune confidence
  -- over time. Cents.
  measured_outcome_cents int,

  prompt_version text NOT NULL,
  -- Cumulative API cost (cents) attributable to this recommendation
  -- generation pass. numeric(10,4) matches the api_costs.cost convention
  -- (sub-cent precision for tiny calls).
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_recommendations IS
  'owner:intelligence. Wave 6C reallocation recommendations. One row per '
  'specific recommendation produced by the Sonnet analyst. Read by '
  '/intel/marketing-roi/recommendations dashboard + the embedded '
  'MarketingRecommendationsPanel. FLAG-DON''T-EXECUTE: the system never '
  'auto-spends; status defaults to ''pending'' awaiting coordinator '
  'decision. Migration 269.';

COMMENT ON COLUMN public.marketing_recommendations.recommendation_title IS
  'Short headline (< 80 chars). Used as a card title. The LLM is asked '
  'to keep it tight; the dashboard truncates beyond that.';

COMMENT ON COLUMN public.marketing_recommendations.action_type IS
  'reallocate | pause | scale | investigate | other. Drives the card '
  'visuals (arrow, badge color). investigate is the LLM''s honest signal '
  'when the data is too thin to recommend a spend move.';

COMMENT ON COLUMN public.marketing_recommendations.estimated_monthly_dollar_impact_cents IS
  'Projected lift in cents per month. SIGNED — positive for upside (scale, '
  'better-cell reallocation), negative for downside the operator absorbs. '
  'Cents not dollars to match the rest of the platform.';

COMMENT ON COLUMN public.marketing_recommendations.reasoning_chain IS
  'Structured reasoning. Required keys: evidence_signals (string array of '
  'specific cell numbers cited), assumed_baseline (string), '
  'projected_outcome (string), counterfactual (what happens if we DON''T '
  'reallocate), payback_months (number), key_risks (string array).';

COMMENT ON COLUMN public.marketing_recommendations.input_data_hash IS
  'Hash of the input dataset (rollups + cohort_intel + external signals). '
  'Service layer short-circuits "same hash → last week''s rec stands" so '
  'unchanged data does not produce duplicate rows.';

COMMENT ON COLUMN public.marketing_recommendations.n_too_small_warning IS
  'True when the cohort underlying this rec has < 10 weddings (source or '
  'target cell). Belt-and-suspenders flag even when the LLM tried to '
  'recommend; the dashboard renders a soft-warn chip so the coordinator '
  'reads the rec with the right grain of salt.';

COMMENT ON COLUMN public.marketing_recommendations.status IS
  'Lifecycle: pending → accepted → in_progress → completed (or declined / '
  'invalidated terminal). Wave 6C never auto-progresses status — every '
  'transition is operator-decided.';

COMMENT ON COLUMN public.marketing_recommendations.measured_outcome_cents IS
  'Post-action measurement. Operator records actual revenue impact in '
  'cents so the dashboard can show projected vs measured (variance pct). '
  'Feeds future confidence calibration.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendations_venue_status_generated
  ON public.marketing_recommendations (venue_id, status, generated_at DESC);

COMMENT ON INDEX public.idx_marketing_recommendations_venue_status_generated IS
  'Hot-path: dashboard reads "pending recs for this venue, newest first". '
  'Status filter is the most common scope.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendations_venue_source_channel
  ON public.marketing_recommendations (venue_id, source_channel)
  WHERE source_channel IS NOT NULL;

COMMENT ON INDEX public.idx_marketing_recommendations_venue_source_channel IS
  'Per-channel drill-down: "all recs that propose moving spend AWAY from '
  'this channel". Partial index keeps the entries small.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendations_venue_target_channel
  ON public.marketing_recommendations (venue_id, target_channel)
  WHERE target_channel IS NOT NULL;

COMMENT ON INDEX public.idx_marketing_recommendations_venue_target_channel IS
  'Per-channel drill-down: "all recs that propose moving spend INTO this '
  'channel". Partial index keeps the entries small.';

-- ============================================================================
-- STEP 2 — marketing_recommendation_jobs (queue table)
-- ============================================================================
-- Mirrors identity_reconstruction_jobs (mig 260) shape so the sweep code
-- can use the same atomic-claim pattern.

CREATE TABLE IF NOT EXISTS public.marketing_recommendation_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  -- Free-text label of the signal that triggered this enqueue. Common
  -- values: 'manual', 'drift_refresh', 'admin_backfill',
  -- 'persona_channel_rollup_completed'.
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text,
  -- Number of recommendations produced by the run (when done).
  recommendations_produced int,
  -- Cumulative cost in cents.
  cost_cents numeric(10,4)
);

COMMENT ON TABLE public.marketing_recommendation_jobs IS
  'owner:intelligence. Wave 6C recommendation-job queue. Mirrors the '
  'identity_reconstruction_jobs shape so the sweep can atomically claim '
  'the oldest queued job. Default trigger is the weekly drift refresh; '
  'manual / admin_backfill paths also enqueue here. Migration 269.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendation_jobs_dequeue
  ON public.marketing_recommendation_jobs (status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_marketing_recommendation_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=''queued'' '
  'LIMIT 1. Partial index so the queue stays cheap to scan even after '
  'historical done/failed rows accumulate.';

CREATE INDEX IF NOT EXISTS idx_marketing_recommendation_jobs_venue
  ON public.marketing_recommendation_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_marketing_recommendation_jobs_venue IS
  '24h dedupe lookup: "is there already a queued/running job for this '
  'venue within the last 24h?" Sweep uses this to avoid double-spending '
  'Sonnet on signal bursts.';

-- ============================================================================
-- STEP 3 — RLS (mirror persona_channel_rollups pattern from mig 266)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role bypasses
-- RLS for the recommendation writer + sweep cron + admin endpoints.
-- Authenticated coordinators may UPDATE their venue's recommendations
-- (status / decision_note / measured_outcome) — that's the Decide /
-- Measure path. INSERT + DELETE are reserved for service-role: only the
-- generation service writes new rows.

ALTER TABLE public.marketing_recommendations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_recommendations_auth_select"
  ON public.marketing_recommendations;
CREATE POLICY "marketing_recommendations_auth_select"
  ON public.marketing_recommendations
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_recommendations_auth_insert"
  ON public.marketing_recommendations;
CREATE POLICY "marketing_recommendations_auth_insert"
  ON public.marketing_recommendations
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_recommendations_auth_update"
  ON public.marketing_recommendations;
CREATE POLICY "marketing_recommendations_auth_update"
  ON public.marketing_recommendations
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

DROP POLICY IF EXISTS "marketing_recommendations_auth_delete"
  ON public.marketing_recommendations;
CREATE POLICY "marketing_recommendations_auth_delete"
  ON public.marketing_recommendations
  FOR DELETE
  TO authenticated
  USING (false);

ALTER TABLE public.marketing_recommendation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_recommendation_jobs_auth_select"
  ON public.marketing_recommendation_jobs;
CREATE POLICY "marketing_recommendation_jobs_auth_select"
  ON public.marketing_recommendation_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_recommendation_jobs_auth_insert"
  ON public.marketing_recommendation_jobs;
CREATE POLICY "marketing_recommendation_jobs_auth_insert"
  ON public.marketing_recommendation_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_recommendation_jobs_auth_update"
  ON public.marketing_recommendation_jobs;
CREATE POLICY "marketing_recommendation_jobs_auth_update"
  ON public.marketing_recommendation_jobs
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_recommendation_jobs_auth_delete"
  ON public.marketing_recommendation_jobs;
CREATE POLICY "marketing_recommendation_jobs_auth_delete"
  ON public.marketing_recommendation_jobs
  FOR DELETE
  TO authenticated
  USING (false);

COMMIT;

NOTIFY pgrst, 'reload schema';
