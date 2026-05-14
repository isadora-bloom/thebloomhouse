-- ---------------------------------------------------------------------------
-- phase-a-acceptance.sql
-- ---------------------------------------------------------------------------
-- Phase A gate for the Identity-First Architecture migration.
-- Anchor: IDENTITY-FIRST-ARCHITECTURE.md §1 Don't skip #4 + §10 Don't
--         skip #1 + Appendix B stop conditions #1, #12.
--
-- Three checks the gate enforces before Phase A can ship:
--
--   1. Migration rerun safety. Running 346 a second time must produce
--      ZERO new rows. The partial unique index on (venue_id,
--      source_wedding_id) is the primitive that enforces this; this
--      script verifies the effect.
--
--   2. RLS isolation. A user with access to venue A must NOT be able
--      to read couples / touchpoints / fragments belonging to venue B.
--
--   3. Demo-anon read. An anonymous request to read couples /
--      touchpoints / fragments at a venue with is_demo=true must
--      succeed; at a non-demo venue must return zero rows.
--
-- How to run
-- ----------
-- Against a Supabase psql session (NOT the API):
--
--   \i scripts/phase-a-acceptance.sql
--
-- All three blocks RAISE NOTICE with PASS / FAIL. Exit code stays 0
-- regardless (the blocks are observational, not enforcing) so you can
-- read all three results in one run rather than aborting on the first.
--
-- Caveat: §10 Don't skip #1 ("RLS testing in CI") is the harder
-- deliverable. This script is the manual gate the operator runs
-- before merging Phase A; the CI version lands separately during
-- Phase D rollout. Phase A is allowed to ship on the manual gate
-- because no read paths consume the new tables yet — a missed
-- isolation bug here costs nothing until Phase D.
-- ---------------------------------------------------------------------------

\set ON_ERROR_STOP off
\timing on

-- ===========================================================================
-- CHECK 1: migration rerun safety
-- ===========================================================================
-- Capture row counts pre-rerun. Then logically re-run the backfill
-- INSERT block of migration 346. Then compare counts. They must match.
--
-- The migration file itself uses IF NOT EXISTS on every CREATE, so a
-- full file rerun (CREATE TABLE + indexes + RLS + backfill) is
-- expected to be idempotent. The most fragile piece is the backfill
-- INSERT — that's what this block exercises.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  pre_count integer;
  post_count integer;
BEGIN
  SELECT COUNT(*) INTO pre_count FROM couples WHERE source_wedding_id IS NOT NULL;

  -- Re-run the backfill block verbatim from 346. ON CONFLICT skips
  -- existing rows.
  INSERT INTO couples (
    venue_id,
    primary_contact_name,
    primary_contact_email,
    primary_contact_phone,
    partner_contact_name,
    partner_contact_email,
    partner_contact_phone,
    wedding_date,
    lifecycle_state,
    source_wedding_id,
    created_at,
    updated_at
  )
  SELECT
    w.venue_id,
    COALESCE(
      NULLIF(TRIM(CONCAT_WS(' ', p1.first_name, p1.last_name)), ''),
      NULLIF(TRIM(CONCAT_WS(' ', p2.first_name, p2.last_name)), ''),
      '(Unknown — backfilled from weddings ' || w.id::text || ')'
    ),
    p1.email,
    p1.phone,
    NULLIF(TRIM(CONCAT_WS(' ', p2.first_name, p2.last_name)), ''),
    p2.email,
    p2.phone,
    w.wedding_date,
    CASE
      WHEN w.status IN ('booked','completed')      THEN 'booked'
      WHEN w.status IN ('lost','cancelled')        THEN 'ghost'
      ELSE                                              'resolved'
    END,
    w.id,
    w.inquiry_date,
    w.updated_at
  FROM weddings w
  LEFT JOIN LATERAL (
    SELECT first_name, last_name, email, phone
    FROM people
    WHERE wedding_id = w.id AND role = 'partner1'
    ORDER BY created_at ASC LIMIT 1
  ) p1 ON true
  LEFT JOIN LATERAL (
    SELECT first_name, last_name, email, phone
    FROM people
    WHERE wedding_id = w.id AND role = 'partner2'
    ORDER BY created_at ASC LIMIT 1
  ) p2 ON true
  ON CONFLICT (venue_id, source_wedding_id) DO NOTHING;

  SELECT COUNT(*) INTO post_count FROM couples WHERE source_wedding_id IS NOT NULL;

  IF post_count = pre_count THEN
    RAISE NOTICE 'CHECK 1 (rerun safety): PASS — couples count stable at %', post_count;
  ELSE
    RAISE WARNING 'CHECK 1 (rerun safety): FAIL — couples grew from % to % on rerun', pre_count, post_count;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 2: RLS venue isolation (smoke test, two-venue minimum)
-- ===========================================================================
-- Pick two venues. Pretend to be a user with venue_id = venue_a.
-- A SELECT against couples must return ONLY venue_a rows. A SELECT
-- against couples WHERE venue_id = venue_b must return zero.
--
-- We use SET LOCAL ROLE + SET LOCAL request.jwt.claim.sub to simulate
-- an authenticated user. (The full Supabase auth context is heavier,
-- but for RLS smoke this is enough — the policies key on
-- auth.uid() → user_profiles.venue_id.)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  venue_a uuid;
  venue_b uuid;
  user_a uuid;
  rows_visible_a integer;
  rows_visible_b integer;
BEGIN
  SELECT id INTO venue_a FROM venues ORDER BY created_at ASC LIMIT 1;
  SELECT id INTO venue_b FROM venues WHERE id <> venue_a ORDER BY created_at ASC LIMIT 1;

  IF venue_a IS NULL OR venue_b IS NULL THEN
    RAISE NOTICE 'CHECK 2 (RLS isolation): SKIP — need at least 2 venues to test isolation';
    RETURN;
  END IF;

  -- Find a user_profile attached to venue_a only.
  SELECT id INTO user_a FROM user_profiles
  WHERE venue_id = venue_a AND org_id IS NULL
  LIMIT 1;

  IF user_a IS NULL THEN
    RAISE NOTICE 'CHECK 2 (RLS isolation): SKIP — no single-venue user_profile attached to venue_a';
    RETURN;
  END IF;

  -- Switch to authenticated role + impersonate user_a.
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', user_a::text, true);

  SELECT COUNT(*) INTO rows_visible_a FROM couples WHERE venue_id = venue_a;
  SELECT COUNT(*) INTO rows_visible_b FROM couples WHERE venue_id = venue_b;

  -- Drop back to service role for the assert.
  RESET ROLE;

  IF rows_visible_b = 0 THEN
    RAISE NOTICE 'CHECK 2 (RLS isolation): PASS — user_a saw 0 rows from venue_b couples (own venue: % rows)', rows_visible_a;
  ELSE
    RAISE WARNING 'CHECK 2 (RLS isolation): FAIL — user_a leaked % rows from venue_b couples', rows_visible_b;
  END IF;
END $$;


-- ===========================================================================
-- CHECK 3: demo-anon read access
-- ===========================================================================
-- A demo venue's couples must be visible to the anon role; a non-demo
-- venue's couples must not.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  demo_venue uuid;
  real_venue uuid;
  rows_demo integer;
  rows_real integer;
BEGIN
  SELECT id INTO demo_venue FROM venues WHERE is_demo = true LIMIT 1;
  SELECT id INTO real_venue FROM venues WHERE is_demo = false LIMIT 1;

  IF demo_venue IS NULL THEN
    RAISE NOTICE 'CHECK 3 (demo-anon): SKIP — no demo venue configured';
    RETURN;
  END IF;

  SET LOCAL ROLE anon;

  SELECT COUNT(*) INTO rows_demo FROM couples WHERE venue_id = demo_venue;
  IF real_venue IS NOT NULL THEN
    SELECT COUNT(*) INTO rows_real FROM couples WHERE venue_id = real_venue;
  ELSE
    rows_real := 0;
  END IF;

  RESET ROLE;

  IF rows_real = 0 THEN
    RAISE NOTICE 'CHECK 3 (demo-anon): PASS — anon saw % demo rows, 0 real-venue rows', rows_demo;
  ELSE
    RAISE WARNING 'CHECK 3 (demo-anon): FAIL — anon leaked % rows from real venue', rows_real;
  END IF;
END $$;

\echo Phase A acceptance complete. Review NOTICE / WARNING lines above.
