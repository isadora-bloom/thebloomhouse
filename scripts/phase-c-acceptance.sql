-- ---------------------------------------------------------------------------
-- phase-c-acceptance.sql
-- ---------------------------------------------------------------------------
-- Phase C gate for the Identity-First Architecture migration.
-- Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 (Forwards Linker — live
--         counterpart to the Backwards Tracer).
--
-- Four checks the gate enforces:
--
--   1. Linker observability. tracer_run_events should carry rows with
--      stage='forwards_link' once live signals have flowed through.
--      Tracer-only environments stay green (skip).
--
--   2. Match-first-then-fragment. Every fragment within the window
--      should have NO untouched-couple match opportunity — there
--      shouldn't be a couple whose identifier exactly matches the
--      fragment's identity_hint. Surfaces missed-match bugs.
--
--   3. No orphan couples. Every couples row must have at least one
--      touchpoint OR a source_wedding_id (the legacy anchor mirror).
--      A couple with zero touchpoints + no wedding mirror means the
--      linker minted ghost couples — bug class.
--
--   4. Re-link idempotency. The UNIQUE constraints on touchpoints +
--      fragments must hold under replay. Same shape as Phase B
--      check 1; included here because Phase C replay endpoint is a
--      new code path that hits the same primitives.
--
-- How to run
-- ----------
--   \i scripts/phase-c-acceptance.sql
--
-- All blocks RAISE NOTICE with PASS / FAIL. Exit code stays 0 so all
-- four read in one shot. Sibling: scripts/phase-b-acceptance.sql.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP off
\timing on

-- ===========================================================================
-- CHECK 1: forwards_link telemetry plumbed
-- ===========================================================================
-- After any live signal flows through linkSignal, tracer_run_events
-- gets stage='forwards_link' rows tagged with the daily live: run_id.
-- The dashboard's signals-seen aggregation runs off this table.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  any_link_events integer;
  any_live_runs integer;
BEGIN
  SELECT COUNT(*) INTO any_link_events
  FROM public.tracer_run_events
  WHERE stage = 'forwards_link';

  SELECT COUNT(DISTINCT run_id) INTO any_live_runs
  FROM public.tracer_run_events
  WHERE stage = 'forwards_link'
    AND run_id LIKE 'live:%';

  IF any_link_events = 0 THEN
    RAISE NOTICE 'CHECK 1 (linker telemetry): SKIP — no forwards_link rows yet';
  ELSE
    RAISE NOTICE 'CHECK 1 (linker telemetry): PASS — % forwards_link events across % live runs',
      any_link_events, any_live_runs;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 2: fragments are real misses (not missed matches)
-- ===========================================================================
-- Pick the most recent 200 fragments. For each, check whether a
-- couples row exists whose primary_contact_email or primary_contact_phone
-- equals the fragment's identity_hint OR raw_payload->>'primary_email'.
-- If yes, the linker dropped a real match. Anything > 5% miss rate
-- = matcher bug.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  total integer;
  missed integer;
  miss_rate numeric;
BEGIN
  SELECT COUNT(*) INTO total FROM (
    SELECT id FROM public.fragments
    ORDER BY occurred_at DESC
    LIMIT 200
  ) f;
  IF total = 0 THEN
    RAISE NOTICE 'CHECK 2 (no missed matches): SKIP — no fragments yet';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO missed
  FROM (
    SELECT id FROM public.fragments
    ORDER BY occurred_at DESC
    LIMIT 200
  ) f
  JOIN public.fragments fr ON fr.id = f.id
  WHERE EXISTS (
    SELECT 1 FROM public.couples c
    WHERE c.venue_id = fr.venue_id
      AND (
        (c.primary_contact_email IS NOT NULL
          AND LOWER(c.primary_contact_email) = LOWER(fr.raw_payload->>'primary_email'))
        OR (c.primary_contact_phone IS NOT NULL
          AND c.primary_contact_phone = fr.raw_payload->>'primary_phone')
      )
  );

  miss_rate := 100.0 * missed / total;
  IF miss_rate <= 5.0 THEN
    RAISE NOTICE 'CHECK 2 (no missed matches): PASS — %/% (%.2f%%) within 5%% threshold',
      missed, total, miss_rate;
  ELSE
    RAISE WARNING 'CHECK 2 (no missed matches): FAIL — %/% (%.2f%%) fragments have an exact-match couple — matcher / linker bug',
      missed, total, miss_rate;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 3: no orphan couples
-- ===========================================================================
-- Every couples row must have at least one touchpoint OR a
-- source_wedding_id (legacy anchor). A couple with neither was either
-- minted by a bug or its only touchpoint got deleted — in both cases
-- it shouldn't be there.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  orphan_count integer;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM public.couples c
  WHERE c.source_wedding_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.touchpoints tp WHERE tp.couple_id = c.id
    );

  IF orphan_count = 0 THEN
    RAISE NOTICE 'CHECK 3 (no orphan couples): PASS — every couple has either a wedding-mirror or at least one touchpoint';
  ELSE
    RAISE WARNING 'CHECK 3 (no orphan couples): FAIL — % couples with no wedding-mirror and no touchpoints',
      orphan_count;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 4: replay-safe (touchpoint + fragment UNIQUE constraints)
-- ===========================================================================
-- The replay endpoint re-runs linkSignal against past N days of
-- signals. It must produce zero net new touchpoint / fragment rows
-- on a stable corpus. We simulate by attempting a duplicate insert
-- via the same (venue_id, channel, external_id) key and confirming
-- the unique constraint rejects.
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
    RAISE NOTICE 'CHECK 4 (replay-safe): SKIP — no venues';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO pre_tp FROM public.touchpoints WHERE venue_id = venue;
  SELECT COUNT(*) INTO pre_frag FROM public.fragments WHERE venue_id = venue;

  BEGIN
    INSERT INTO public.touchpoints (
      venue_id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload
    )
    SELECT venue_id, channel, signal_tier, action_type, external_id, occurred_at, raw_payload
    FROM public.touchpoints WHERE venue_id = venue LIMIT 5;
  EXCEPTION WHEN unique_violation THEN
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
    RAISE NOTICE 'CHECK 4 (replay-safe): PASS — touchpoints stable at %, fragments stable at %',
      post_tp, post_frag;
  ELSE
    RAISE WARNING 'CHECK 4 (replay-safe): FAIL — touchpoints %→% fragments %→%',
      pre_tp, post_tp, pre_frag, post_frag;
  END IF;
END $$;


\echo Phase C acceptance complete. Review NOTICE / WARNING lines above.
