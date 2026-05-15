-- ---------------------------------------------------------------------------
-- phase-b-acceptance.sql
-- ---------------------------------------------------------------------------
-- Phase B gate for the Identity-First Architecture migration.
-- Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 (Backwards Tracer) +
--         Appendix B stop conditions #2 / #3 / #4.
--
-- Four checks the gate enforces:
--
--   1. Tracer rerun safety. The UNIQUE constraints on
--      touchpoints(venue_id, channel, external_id) and
--      fragments(venue_id, channel, external_id) must hold. A second
--      tracer run on the same data writes zero new rows. We verify
--      by counting rows before/after a synthetic re-insert.
--
--   2. No-anchors → cold-start. A venue with zero booked-anchor
--      couples must NOT have an in-progress tracer_run_events row
--      past stage='anchor_discovery' with status='succeeded'. Phase
--      B's contract is to short-circuit (§4 Don't skip #4).
--
--   3. LLM judge wired check. couple_merge_events rows with reason
--      prefix 'llm_judge:' should appear after any run that hit the
--      40-90 ambiguous band (Appendix B stop #3). The 50-pair fixture
--      gate at scripts/matcher-acceptance.ts handles the accuracy
--      side; this check just verifies the writer is plumbed.
--
--   4. Candidate match resolution invariant. Every candidate_matches
--      row must reference real records — primary_record_id /
--      secondary_record_id either exists in couples (for 'couple'
--      record_type) or fragments (for 'fragment' record_type).
--      Foreign-key-like check that we missed when shipping.
--
-- How to run
-- ----------
--   \i scripts/phase-b-acceptance.sql
--
-- All blocks RAISE NOTICE with PASS / FAIL. Exit code stays 0 so all
-- four read in one shot. The Phase A acceptance gate at
-- scripts/phase-a-acceptance.sql is the upstream sibling.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP off
\timing on

-- ===========================================================================
-- CHECK 1: touchpoints + fragments rerun safety
-- ===========================================================================
-- UNIQUE(venue_id, channel, external_id) is the rerun primitive. We
-- synthesise a touchpoints insert pattern that would duplicate, attempt
-- it, and confirm Postgres rejects (or ON CONFLICT skips).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  venue uuid;
  pre_tp integer;
  post_tp integer;
  pre_frag integer;
  post_frag integer;
BEGIN
  SELECT id INTO venue FROM public.venues ORDER BY created_at ASC LIMIT 1;
  IF venue IS NULL THEN
    RAISE NOTICE 'CHECK 1 (rerun safety): SKIP — no venues';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO pre_tp FROM public.touchpoints WHERE venue_id = venue;
  SELECT COUNT(*) INTO pre_frag FROM public.fragments WHERE venue_id = venue;

  -- Idempotent insert pattern the Tracer uses. Re-insert the existing
  -- (channel, external_id) rows; Postgres should reject with 23505 and
  -- our DO $$ ... EXCEPTION handles it. Net rows = 0.
  BEGIN
    INSERT INTO public.touchpoints (
      venue_id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload
    )
    SELECT venue_id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload
    FROM public.touchpoints WHERE venue_id = venue LIMIT 5;
  EXCEPTION WHEN unique_violation THEN
    -- expected
    NULL;
  END;

  BEGIN
    INSERT INTO public.fragments (
      venue_id, channel, identity_hint, external_id, occurred_at, raw_payload
    )
    SELECT venue_id, channel, identity_hint, external_id, occurred_at, raw_payload
    FROM public.fragments WHERE venue_id = venue LIMIT 5;
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  SELECT COUNT(*) INTO post_tp FROM public.touchpoints WHERE venue_id = venue;
  SELECT COUNT(*) INTO post_frag FROM public.fragments WHERE venue_id = venue;

  IF post_tp = pre_tp AND post_frag = pre_frag THEN
    RAISE NOTICE 'CHECK 1 (rerun safety): PASS — touchpoints stable at %, fragments stable at %', post_tp, post_frag;
  ELSE
    RAISE WARNING 'CHECK 1 (rerun safety): FAIL — touchpoints %→%  fragments %→%', pre_tp, post_tp, pre_frag, post_frag;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 2: cold-start short-circuit
-- ===========================================================================
-- Find a venue with zero booked-anchor couples. If no such venue exists
-- the check skips. Otherwise, scan tracer_run_events for that venue and
-- assert every run either has zero events past anchor_discovery, or has
-- an anchor_discovery row with status='skipped'.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  no_anchor_venue uuid;
  bad_runs integer;
BEGIN
  SELECT v.id INTO no_anchor_venue
  FROM public.venues v
  WHERE NOT EXISTS (
    SELECT 1 FROM public.couples c
    WHERE c.venue_id = v.id AND c.lifecycle_state IN ('booked','resolved')
  )
  LIMIT 1;

  IF no_anchor_venue IS NULL THEN
    RAISE NOTICE 'CHECK 2 (cold-start): SKIP — every venue has at least one anchor';
    RETURN;
  END IF;

  -- For runs on a zero-anchor venue, anchor_discovery must have been
  -- skipped and NO touchpoint_sweep (or later) should have a 'succeeded'
  -- row. If any do, the Tracer ran a degenerate sweep — bug.
  SELECT COUNT(*) INTO bad_runs
  FROM public.tracer_run_events
  WHERE venue_id = no_anchor_venue
    AND stage IN ('touchpoint_sweep','cross_channel_coalesce','agent_infer')
    AND status = 'succeeded';

  IF bad_runs = 0 THEN
    RAISE NOTICE 'CHECK 2 (cold-start): PASS — no degenerate sweep recorded on zero-anchor venue';
  ELSE
    RAISE WARNING 'CHECK 2 (cold-start): FAIL — % stage-succeeded rows on zero-anchor venue %', bad_runs, no_anchor_venue;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 3: LLM judge wired (Appendix B stop #3)
-- ===========================================================================
-- Every successful judge invocation writes a tracer_run_events row with
-- stage='llm_judge' and detail.prompt_version set. The check is real:
-- if any Tracer run processed at least 100 signals (enough that at
-- least one candidate-pair should hit the 40-90 band on real data),
-- and zero llm_judge rows exist, the writer is unplumbed and this is
-- a stop. With minimal signals, we SKIP.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  signals_processed integer;
  judge_rows integer;
  judge_versions integer;
BEGIN
  -- Total signals processed across all completed Tracer runs.
  SELECT COALESCE(SUM((detail->'run_totals'->>'signals_seen')::integer), 0)
  INTO signals_processed
  FROM public.tracer_run_events
  WHERE stage = 'validate'
    AND status = 'succeeded'
    AND detail ? 'run_totals';

  SELECT COUNT(*) INTO judge_rows
  FROM public.tracer_run_events
  WHERE stage = 'llm_judge';

  SELECT COUNT(DISTINCT detail->>'prompt_version') INTO judge_versions
  FROM public.tracer_run_events
  WHERE stage = 'llm_judge'
    AND detail ? 'prompt_version';

  IF signals_processed < 100 THEN
    RAISE NOTICE 'CHECK 3 (judge wired): SKIP — only % signals processed; need >=100 to expect judge band hits',
      signals_processed;
  ELSIF judge_rows = 0 THEN
    RAISE WARNING 'CHECK 3 (judge wired): FAIL — % signals processed with zero stage=llm_judge rows. Writer unplumbed (Appendix B stop #3).',
      signals_processed;
  ELSE
    RAISE NOTICE 'CHECK 3 (judge wired): PASS — % judge invocations across % prompt versions for % signals processed',
      judge_rows, judge_versions, signals_processed;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 4: candidate_matches referential integrity
-- ===========================================================================
-- candidate_matches has no real FK to couples/fragments (the column is
-- polymorphic via primary_record_type). This check asserts every
-- referenced id resolves.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM public.candidate_matches cm
  WHERE
    (cm.primary_record_type = 'couple' AND NOT EXISTS (SELECT 1 FROM public.couples WHERE id = cm.primary_record_id))
    OR (cm.primary_record_type = 'fragment' AND NOT EXISTS (SELECT 1 FROM public.fragments WHERE id = cm.primary_record_id))
    OR (cm.secondary_record_type = 'couple' AND NOT EXISTS (SELECT 1 FROM public.couples WHERE id = cm.secondary_record_id))
    OR (cm.secondary_record_type = 'fragment' AND NOT EXISTS (SELECT 1 FROM public.fragments WHERE id = cm.secondary_record_id));

  IF orphan_count = 0 THEN
    RAISE NOTICE 'CHECK 4 (candidate_match integrity): PASS — every reference resolves';
  ELSE
    RAISE WARNING 'CHECK 4 (candidate_match integrity): FAIL — % orphan references in candidate_matches', orphan_count;
  END IF;
END $$;

\echo Phase B acceptance complete. Review NOTICE / WARNING lines above.
