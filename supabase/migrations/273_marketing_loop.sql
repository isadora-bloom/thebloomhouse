-- ---------------------------------------------------------------------------
-- 273_marketing_loop.sql
-- ---------------------------------------------------------------------------
-- Wave 6D — closing the marketing loop.
--
-- Anchor docs:
--   - bloom-constitution.md (Wave 6 closes the forensic loop. 6A ingests
--     spend, 6B rolls up persona × channel × revenue, 6C produces the
--     reallocation recommendations, 6D flags under/over-performance, sets
--     up A/B scaffolds, delivers a weekly digest.)
--   - bloom-wave4-5-6-master-plan.md (Wave 6D spec)
--   - feedback_parallel_stream_safety.md (Wave 6D holds migration 273.
--     Wave 7C holds 272. Wave 8 holds 271. We don't write into anyone
--     else's lane and we don't touch their writer code.)
--
-- Why this migration exists
-- -------------------------
-- Wave 6C produces explicit reallocation recommendations the operator
-- decides on. Wave 6D is the around-the-recommendations layer:
--
--   * marketing_spend_flags — auto-detected red/green flags from the
--     rollup matrix. CAC>LTV cells, underperforming pause candidates,
--     overperforming scale candidates, persona drift, channel anomalies.
--     Surfaced as a triage panel; the system never auto-acts.
--
--   * marketing_ab_tests — lightweight A/B test scaffold for competing
--     creatives / channels / persona-targeting. Tracks which
--     attribution_events count as variant_a vs variant_b. Computes lift
--     when both arms have ≥ 30 events; refuses to conclude before that.
--
--   * marketing_digests — weekly digest history. One row per
--     (venue, week). Pulls top flags + top recs + week-over-week metric
--     changes + concluded A/B tests + validated discoveries (Wave 7C),
--     then asks Sonnet to author the headline + narrative.
--
--   * marketing_loop_jobs — sweep queue (mirror of the recommendation
--     queue from mig 269).
--
-- Doctrine: AUTO-FLAG, NEVER AUTO-EXECUTE. Every transition is operator-
-- decided. The migration shapes the data; the service layer enforces the
-- "no auto-spend" invariant.
--
-- Idempotent: every CREATE TABLE / CREATE INDEX / CREATE POLICY uses
-- IF NOT EXISTS or DROP-then-CREATE. Safe to re-run.
-- ---------------------------------------------------------------------------

BEGIN;

-- ============================================================================
-- STEP 1 — marketing_spend_flags (one row per active flag)
-- ============================================================================
-- Re-detection updates last_confirmed_at on the existing row instead of
-- inserting a duplicate. The unique constraint on
-- (venue_id, flag_type, source_channel, target_persona) is the
-- identity of an "active flag" — same condition same row.

CREATE TABLE IF NOT EXISTS public.marketing_spend_flags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Flag taxonomy (drives icon + severity defaults on the dashboard).
  --   underperforming_pause_candidate — ROI < 50% of channel-blended avg
  --     AND spend > $500/mo for 14d (warning)
  --   overperforming_scale_candidate  — ROI > 200% of channel-blended avg
  --     AND n>=10 (info)
  --   cac_exceeds_ltv — CAC > 30% of avg booking value, n>=10, sustained
  --     14d (critical)
  --   persona_drift — couple_intel persona distribution shifts >15% in a
  --     30d window vs prior 30d (warning)
  --   channel_anomaly — channel CAC suddenly doubles week-over-week
  --     (warning)
  flag_type text NOT NULL
    CHECK (flag_type IN (
      'underperforming_pause_candidate',
      'overperforming_scale_candidate',
      'cac_exceeds_ltv',
      'persona_drift',
      'channel_anomaly'
    )),

  -- Short headline ("Knot × Heritage-Forward CAC > LTV"). Used as a
  -- card title; the dashboard truncates beyond ~80 chars.
  flag_title text NOT NULL,

  -- Full explanation paragraph. The "story" the operator reads first
  -- before drilling into cohort_data + recommended_action.
  flag_text text NOT NULL,

  -- Drives card visuals + sort order.
  --   info     — directional signal, no urgent action needed
  --   warning  — sustained underperformance / drift; review this week
  --   critical — CAC>LTV class — immediate review
  severity text NOT NULL
    CHECK (severity IN ('info', 'warning', 'critical')),

  -- Channel + persona scope. NULL when the flag is multi-channel or
  -- venue-wide (e.g. persona_drift is venue-wide, target_persona may
  -- be NULL on channel_anomaly).
  source_channel text,
  target_persona text,

  -- The rollup numbers that triggered the flag. Frozen at detection
  -- time so the operator can audit "why was this flagged on May 9?"
  -- even after the rollup has been recomputed. Schema is flag-type
  -- specific; the service layer is the authority. Common keys:
  --   roi_pct, cac_cents, conversion_pct, n_too_small, channel_avg_*,
  --   prior_window / current_window for drift flags.
  cohort_data jsonb NOT NULL,

  -- How many days the underlying condition has held. Drives the
  -- 14d-sustained gate for pause/cac_exceeds_ltv flags. Updated each
  -- detection sweep.
  duration_days int NOT NULL DEFAULT 0
    CHECK (duration_days >= 0),

  -- Revenue at stake (cents). Signed: positive when the flag points to
  -- recoverable upside (scale candidate), negative when the flag points
  -- to ongoing waste (pause candidate). Cents not dollars.
  estimated_impact_cents int,

  -- Imperative phrasing ("Consider pausing Knot × Heritage-Forward").
  -- The flag never auto-acts — this string is the operator's prompt.
  recommended_action text,

  -- Lifecycle:
  --   pending      — newly detected, awaiting coordinator triage
  --   acknowledged — coordinator has seen it (next: actioned / dismissed)
  --   actioned     — operator did something based on the flag
  --   dismissed    — operator decided no action needed
  --   resolved     — system auto-resolved (condition no longer holds for 7d)
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'acknowledged', 'actioned', 'dismissed', 'resolved')),

  -- Detection lifecycle timestamps.
  first_detected_at timestamptz NOT NULL DEFAULT now(),
  -- Updated each sweep that re-confirms the flag still applies. Drives
  -- duration_days math.
  last_confirmed_at timestamptz NOT NULL DEFAULT now(),

  -- Operator decision audit.
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES auth.users(id),
  acknowledgment_note text,
  resolved_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_spend_flags IS
  'owner:intelligence. Wave 6D auto-detected flags from the persona × '
  'channel rollup matrix. One row per (venue, flag_type, source_channel, '
  'target_persona) tuple — re-detection updates last_confirmed_at instead '
  'of inserting a duplicate. AUTO-FLAG NEVER AUTO-EXECUTE: operator '
  'decides acknowledge / action / dismiss; system auto-resolves only when '
  'the condition no longer holds for 7d. Migration 273.';

COMMENT ON COLUMN public.marketing_spend_flags.cohort_data IS
  'Frozen rollup numbers that triggered the flag. Lets the operator '
  'audit "why was this flagged" later even after the rollup has been '
  'recomputed. Schema is flag-type specific; the service layer is the '
  'authority.';

COMMENT ON COLUMN public.marketing_spend_flags.duration_days IS
  'How many days the underlying condition has held. Drives the '
  '14d-sustained gate for pause/cac_exceeds_ltv flags. Updated each '
  'detection sweep.';

COMMENT ON COLUMN public.marketing_spend_flags.estimated_impact_cents IS
  'Revenue at stake (cents). Signed — positive when the flag points to '
  'recoverable upside (scale candidate), negative when the flag points '
  'to ongoing waste (pause candidate). Cents not dollars.';

COMMENT ON COLUMN public.marketing_spend_flags.status IS
  'Lifecycle: pending → acknowledged → actioned/dismissed (operator '
  'decisions) OR pending → resolved (system auto-resolves when condition '
  'fails to re-confirm for 7d). Wave 6D never auto-progresses to '
  'actioned.';

-- One active flag per (venue, condition). The unique constraint includes
-- COALESCE'd nulls so a venue-wide flag (NULL channel, NULL persona)
-- still de-dupes against itself. Partial — only enforced for non-resolved
-- flags so the historical resolved trail stays intact.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketing_spend_flags_active
  ON public.marketing_spend_flags (
    venue_id,
    flag_type,
    COALESCE(source_channel, ''),
    COALESCE(target_persona, '')
  )
  WHERE status <> 'resolved';

COMMENT ON INDEX public.uniq_marketing_spend_flags_active IS
  'One active flag per (venue, flag_type, channel, persona). Partial — '
  'allows the historical resolved trail to keep multiple rows for the '
  'same condition over time. Re-detection updates last_confirmed_at on '
  'the active row instead of inserting a duplicate.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_flags_venue_status_severity
  ON public.marketing_spend_flags (venue_id, status, severity);

COMMENT ON INDEX public.idx_marketing_spend_flags_venue_status_severity IS
  'Hot-path: dashboard reads "pending flags for this venue, ordered by '
  'severity desc". Status + severity filters drive the triage view.';

CREATE INDEX IF NOT EXISTS idx_marketing_spend_flags_venue_last_confirmed
  ON public.marketing_spend_flags (venue_id, last_confirmed_at DESC);

COMMENT ON INDEX public.idx_marketing_spend_flags_venue_last_confirmed IS
  'Auto-resolve sweep: ORDER BY last_confirmed_at ASC WHERE status IN '
  '(pending, acknowledged) — finds flags whose condition has not been '
  're-confirmed recently and may need the 7d resolved transition.';

-- ============================================================================
-- STEP 2 — marketing_ab_tests (A/B test scaffold)
-- ============================================================================
-- Lightweight scaffold: tracks which attribution_events fall in
-- variant_a vs variant_b based on a coordinator-defined filter. Computes
-- lift_pct + decides winner when both arms have ≥ 30 events OR
-- coordinator forces conclusion. Refuses to auto-conclude with
-- insufficient data.

CREATE TABLE IF NOT EXISTS public.marketing_ab_tests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  test_name text NOT NULL,
  hypothesis text NOT NULL,

  -- Human-readable variant labels ("current Knot listing copy",
  -- "new Heritage-Forward Knot copy").
  variant_a_label text NOT NULL,
  variant_b_label text NOT NULL,

  -- Channel + persona scope. Channel mandatory (the test is always
  -- about a channel's performance). Persona optional — multi-persona
  -- tests are valid.
  channel text NOT NULL,
  target_persona text,

  -- Test window.
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,

  -- Which attribution_events count toward each arm. Coordinator
  -- assigns these explicitly (or via a filter the service layer
  -- expands to ids). Arrays — small enough at typical test volumes
  -- (≤ a few hundred events per arm) and removes a join through a
  -- separate junction table. Cap at 10000 ids per arm at the service
  -- layer.
  variant_a_attribution_event_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  variant_b_attribution_event_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],

  -- Conclusion (NULL until both arms reach the cohort threshold OR the
  -- coordinator force-concludes). Allowed values:
  --   variant_a    — A wins
  --   variant_b    — B wins
  --   inconclusive — concluded but no winner (ties or arms too thin)
  winner text
    CHECK (winner IS NULL OR winner IN ('variant_a', 'variant_b', 'inconclusive')),
  -- The lift the winning arm showed against the loser, signed pct.
  -- Positive = winner's metric exceeded loser's. Null until concluded.
  winner_decision_lift_pct numeric(7,2),
  winner_decided_at timestamptz,
  winner_decided_by uuid REFERENCES auth.users(id),

  -- Lifecycle:
  --   planning  — operator is still building the test; arms may be empty
  --   running   — test is live; assignVariantToAttributionEvent can append
  --   concluded — winner decided OR force-concluded; arms frozen
  --   abandoned — operator killed the test before conclusion
  status text NOT NULL DEFAULT 'running'
    CHECK (status IN ('planning', 'running', 'concluded', 'abandoned')),

  notes text,

  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_ab_tests IS
  'owner:intelligence. Wave 6D A/B test scaffold for competing creatives / '
  'channels / persona-targeting. Lightweight: tracks variant arms as '
  'arrays of attribution_event ids; computes lift when both arms have '
  '>= 30 events. Refuses to auto-conclude with insufficient data. '
  'Migration 273.';

COMMENT ON COLUMN public.marketing_ab_tests.variant_a_attribution_event_ids IS
  'Attribution events counted toward variant A. Arrays cap at 10000 ids '
  'per arm at the service layer (typical test volume is < a few hundred '
  'per arm). Coordinator assigns explicitly or via a filter the service '
  'expands to ids.';

COMMENT ON COLUMN public.marketing_ab_tests.winner IS
  'Conclusion: variant_a | variant_b | inconclusive | NULL (still '
  'running). NULL until both arms reach the 30-event threshold OR '
  'coordinator force-concludes. inconclusive means "concluded but no '
  'winner" — ties or arms too thin even after force.';

COMMENT ON COLUMN public.marketing_ab_tests.status IS
  'Lifecycle: planning → running → concluded (or abandoned terminal). '
  'Wave 6D never auto-progresses planning→running; the operator '
  'explicitly starts the test.';

CREATE INDEX IF NOT EXISTS idx_marketing_ab_tests_venue_status
  ON public.marketing_ab_tests (venue_id, status, started_at DESC);

COMMENT ON INDEX public.idx_marketing_ab_tests_venue_status IS
  'Hot-path: dashboard reads "running tests for this venue, newest first". '
  'Status filter is the most common scope.';

-- ============================================================================
-- STEP 3 — marketing_digests (weekly digest history)
-- ============================================================================
-- One row per (venue, week). Re-running the digest builder with the same
-- (venue, week) updates digest_jsonb in place; it doesn't insert a
-- duplicate. The unique constraint on
-- (venue_id, digest_period_start, digest_period_end) enforces this.

CREATE TABLE IF NOT EXISTS public.marketing_digests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Inclusive start, inclusive end. Conventionally Monday-Sunday for
  -- weekly digests; the service layer rounds.
  digest_period_start date NOT NULL,
  digest_period_end date NOT NULL,

  -- Structured digest output.
  -- Required keys (service-layer authority):
  --   headline                  string  — punchy summary line
  --   this_week_in_3_sentences  string  — narrative paragraph
  --   top_flags                 array   — [{title, severity, recommended_action}]
  --   top_recommendations       array   — [{title, projected_impact_cents}]
  --   week_over_week            object  — {cac_change_pct, conversion_change_pct, roi_change_pct}
  --   ab_tests_concluded        array   — [{name, winner, lift_pct}]
  --   validated_discoveries     array   — [{title, summary}] (Wave 7C feed)
  --   refusal                   string|null
  digest_jsonb jsonb NOT NULL,

  -- Delivery channel + timestamp. NULL until delivered (dashboard-only
  -- path keeps NULL forever; the email/slack paths populate after
  -- delivery succeeds). Allowed values match the integration map.
  delivered_via text
    CHECK (delivered_via IS NULL
           OR delivered_via IN ('email', 'slack', 'dashboard_only')),
  delivered_at timestamptz,

  -- LLM cost (cents) attributable to this digest pass. numeric(10,4)
  -- matches api_costs.cost convention (sub-cent precision for tiny
  -- calls).
  cost_cents numeric(10,4) NOT NULL DEFAULT 0,

  prompt_version text,

  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.marketing_digests IS
  'owner:intelligence. Wave 6D weekly digest history. One row per '
  '(venue, week). Re-running the builder updates digest_jsonb in place; '
  'unique constraint enforces no-duplicate. Read by '
  '/intel/marketing-roi/digest dashboard. Migration 273.';

COMMENT ON COLUMN public.marketing_digests.digest_jsonb IS
  'Structured digest output. Required keys: headline, '
  'this_week_in_3_sentences, top_flags, top_recommendations, '
  'week_over_week (cac/conversion/roi pct deltas), ab_tests_concluded, '
  'validated_discoveries, refusal. Service layer is the authority on '
  'shape.';

COMMENT ON COLUMN public.marketing_digests.delivered_via IS
  'Delivery channel: email | slack | dashboard_only | NULL (not yet '
  'delivered). dashboard_only is a terminal "viewed in UI" state used '
  'before email/slack channels are wired.';

CREATE UNIQUE INDEX IF NOT EXISTS uniq_marketing_digests_period
  ON public.marketing_digests (venue_id, digest_period_start, digest_period_end);

COMMENT ON INDEX public.uniq_marketing_digests_period IS
  'One digest per (venue, week). Re-running the builder upserts on this '
  'index — re-runs replace digest_jsonb in place.';

CREATE INDEX IF NOT EXISTS idx_marketing_digests_venue_generated
  ON public.marketing_digests (venue_id, generated_at DESC);

COMMENT ON INDEX public.idx_marketing_digests_venue_generated IS
  'Hot-path: dashboard reads "latest digest for this venue" + "history '
  'dropdown of past digests, newest first".';

-- ============================================================================
-- STEP 4 — marketing_loop_jobs (sweep queue)
-- ============================================================================
-- Mirrors marketing_recommendation_jobs (mig 269) shape so the sweep
-- code can use the same atomic-claim pattern.

CREATE TABLE IF NOT EXISTS public.marketing_loop_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- Which sweep claimed this. Both sweeps share the queue table so a
  -- single observation surface tells the story of the loop.
  --   flag_detect    — flag detector sweep (daily)
  --   digest_build   — digest builder sweep (weekly)
  job_kind text NOT NULL DEFAULT 'flag_detect'
    CHECK (job_kind IN ('flag_detect', 'digest_build')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'failed', 'skipped')),
  trigger_signal text,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  error_text text,
  -- For flag_detect runs: counts of flags created/confirmed/resolved.
  -- For digest_build runs: 1 if a digest row was written, 0 otherwise.
  results_jsonb jsonb,
  cost_cents numeric(10,4)
);

COMMENT ON TABLE public.marketing_loop_jobs IS
  'owner:intelligence. Wave 6D loop-job queue. Two sweeps share this '
  'queue: flag_detect (daily) + digest_build (weekly). Mirrors '
  'marketing_recommendation_jobs shape so sweeps use the same atomic-'
  'claim pattern. Migration 273.';

CREATE INDEX IF NOT EXISTS idx_marketing_loop_jobs_dequeue
  ON public.marketing_loop_jobs (job_kind, status, enqueued_at)
  WHERE status = 'queued';

COMMENT ON INDEX public.idx_marketing_loop_jobs_dequeue IS
  'Worker dequeue path: ORDER BY enqueued_at WHERE status=queued AND '
  'job_kind=$1 LIMIT 1. Partial index keeps the queue cheap to scan '
  'after historical done/failed rows accumulate.';

CREATE INDEX IF NOT EXISTS idx_marketing_loop_jobs_venue
  ON public.marketing_loop_jobs (venue_id, enqueued_at DESC);

COMMENT ON INDEX public.idx_marketing_loop_jobs_venue IS
  'Per-venue dedupe lookup: "is there already a queued/running job for '
  'this venue + kind in the last 24h?" Sweep uses this to avoid double-'
  'spending on signal bursts.';

-- ============================================================================
-- STEP 5 — RLS (mirror persona_channel_rollups + marketing_recommendations)
-- ============================================================================
-- Authenticated users see their own venue's rows. Service-role bypasses
-- RLS for the writer + sweep cron + admin endpoints. Authenticated
-- coordinators may UPDATE flags + ab_tests (acknowledge / dismiss /
-- conclude) — that's the operator-decision path. INSERT + DELETE are
-- service-role only for flags + digests; ab_tests permits
-- authenticated INSERT (operators create tests from the UI).

-- ---- marketing_spend_flags ----
ALTER TABLE public.marketing_spend_flags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_spend_flags_auth_select"
  ON public.marketing_spend_flags;
CREATE POLICY "marketing_spend_flags_auth_select"
  ON public.marketing_spend_flags
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_spend_flags_auth_insert"
  ON public.marketing_spend_flags;
CREATE POLICY "marketing_spend_flags_auth_insert"
  ON public.marketing_spend_flags
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_spend_flags_auth_update"
  ON public.marketing_spend_flags;
CREATE POLICY "marketing_spend_flags_auth_update"
  ON public.marketing_spend_flags
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

DROP POLICY IF EXISTS "marketing_spend_flags_auth_delete"
  ON public.marketing_spend_flags;
CREATE POLICY "marketing_spend_flags_auth_delete"
  ON public.marketing_spend_flags
  FOR DELETE
  TO authenticated
  USING (false);

-- ---- marketing_ab_tests ----
ALTER TABLE public.marketing_ab_tests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_ab_tests_auth_select"
  ON public.marketing_ab_tests;
CREATE POLICY "marketing_ab_tests_auth_select"
  ON public.marketing_ab_tests
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_ab_tests_auth_insert"
  ON public.marketing_ab_tests;
CREATE POLICY "marketing_ab_tests_auth_insert"
  ON public.marketing_ab_tests
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_ab_tests_auth_update"
  ON public.marketing_ab_tests;
CREATE POLICY "marketing_ab_tests_auth_update"
  ON public.marketing_ab_tests
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

DROP POLICY IF EXISTS "marketing_ab_tests_auth_delete"
  ON public.marketing_ab_tests;
CREATE POLICY "marketing_ab_tests_auth_delete"
  ON public.marketing_ab_tests
  FOR DELETE
  TO authenticated
  USING (false);

-- ---- marketing_digests ----
ALTER TABLE public.marketing_digests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_digests_auth_select"
  ON public.marketing_digests;
CREATE POLICY "marketing_digests_auth_select"
  ON public.marketing_digests
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_digests_auth_insert"
  ON public.marketing_digests;
CREATE POLICY "marketing_digests_auth_insert"
  ON public.marketing_digests
  FOR INSERT
  TO authenticated
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_digests_auth_update"
  ON public.marketing_digests;
CREATE POLICY "marketing_digests_auth_update"
  ON public.marketing_digests
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_digests_auth_delete"
  ON public.marketing_digests;
CREATE POLICY "marketing_digests_auth_delete"
  ON public.marketing_digests
  FOR DELETE
  TO authenticated
  USING (false);

-- ---- marketing_loop_jobs ----
ALTER TABLE public.marketing_loop_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "marketing_loop_jobs_auth_select"
  ON public.marketing_loop_jobs;
CREATE POLICY "marketing_loop_jobs_auth_select"
  ON public.marketing_loop_jobs
  FOR SELECT
  TO authenticated
  USING (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_loop_jobs_auth_insert"
  ON public.marketing_loop_jobs;
CREATE POLICY "marketing_loop_jobs_auth_insert"
  ON public.marketing_loop_jobs
  FOR INSERT
  TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "marketing_loop_jobs_auth_update"
  ON public.marketing_loop_jobs;
CREATE POLICY "marketing_loop_jobs_auth_update"
  ON public.marketing_loop_jobs
  FOR UPDATE
  TO authenticated
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS "marketing_loop_jobs_auth_delete"
  ON public.marketing_loop_jobs;
CREATE POLICY "marketing_loop_jobs_auth_delete"
  ON public.marketing_loop_jobs
  FOR DELETE
  TO authenticated
  USING (false);

COMMIT;

NOTIFY pgrst, 'reload schema';
