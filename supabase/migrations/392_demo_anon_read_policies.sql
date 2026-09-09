-- ============================================================================
-- 392: DEMO ANON READ POLICIES — couple portal
-- ============================================================================
--
-- WHY THIS EXISTS
--
-- Live walk on 2026-09-08 (November Plan W4, see NOVEMBER-PLAN.md finding 1):
-- /couple/hawthorne-manor/ never loads real data — checklist shows 0 tasks and
-- every panel is stuck on its skeleton after 14 seconds.
--
-- Root-cause history, reconstructed from migration text (no prod DB access
-- from this workstation, so this is a from-code audit, not a live query):
--
--   mig 027  Wide-open `anon_select_<table>` (`USING (true)`) added to 49
--            couple-portal tables so the very first demo could read anything.
--            A real leak — any anon caller could read every venue's data.
--   mig 064  Added narrower `demo_anon_select` policies, scoped to
--            `is_demo = true` venues, via a one-time dynamic `information_
--            schema` scan. Ran ONCE against whatever tables/columns existed
--            on that day. Tables added later, or columns added later, never
--            got picked up — there is no trigger that reruns it.
--   mig 225  Dropped every mig-027 wide-open policy, on the stated assumption
--            that mig 064 already covered the same 49 tables. That assumption
--            wasn't checked table-by-table. At least `checklist_items`,
--            `guest_list`, `seating_tables`, `sage_conversations`, `contracts`,
--            `messages`, `timeline` and `wedding_detail_config` show ZERO
--            `demo_anon_select` policy anywhere in migration history — mig
--            006 (or 016/031) enabled RLS on them with authenticated-only
--            policies, mig 027's wide-open policy was their only anon path,
--            and mig 225 removed it with nothing narrower behind it. From
--            that point on, anon reads on those tables returned zero rows —
--            which is exactly "checklist shows 0 tasks".
--   mig 383  (Aug 6) Added RLS + a `demo_anon_select_<table>` policy to 65
--            tables the RLS ratchet flagged as having NO RLS at all. Tables
--            already RLS-enabled since mig 006 (like the ones above) were
--            never "unprotected" by that ratchet's definition, so 383 never
--            touched them and never noticed the missing anon path.
--
-- This migration is the backstop: it re-asserts a `demo_anon_select_<table>`
-- policy on every table the couple-portal pages actually read (grepped from
-- `src/app/_couple-pages/**/page.tsx` + `src/components/couple/**` for
-- `.from('...')`, 2026-09-08), regardless of whether mig 064/225/383 already
-- covered it. DROP IF EXISTS + CREATE makes this safe to run even where a
-- policy of the same name/shape already exists.
--
-- A SECOND, independent bug compounds the "0 tasks" symptom and is at least
-- as significant: the runtime demo wedding id baked into
-- `src/lib/api/auth-helpers.ts` (`DEMO_WEDDING_ID`) and
-- `src/lib/hooks/use-couple-context.ts` is
-- `ab000000-0000-0000-0000-000000000001`. No `weddings` row with that id is
-- created anywhere in the current `supabase/seed*.sql` — the current seed
-- creates Chloe & Ryan as `44444444-4444-4444-4444-444444000109` and every
-- couple-portal seed file (`seed-couple-portal.sql`, `seed-chloe-ryan-fill.sql`,
-- `PASTE-COUPLE-PORTAL-SEED.sql`) keys off that id. `ab000000-...` is a
-- LEFTOVER id from an earlier seed generation (migrations 030 and 036
-- reference it as already-existing, never creating it) — the seed was
-- regenerated under a new id at some point and the runtime constants were
-- never updated to match. This alone is sufficient to explain a wedding-id-
-- scoped page (checklist, budget, timeline, guest list, ...) returning zero
-- rows even with perfect RLS, because `wedding_id = 'ab000000-...'` can never
-- match anything. That id is fixed in code by this workstream separately
-- (see auth-helpers.ts DEMO_WEDDING_ID + the use-couple-context.ts patch
-- note in this workstream's report) — this migration does not touch it,
-- policies don't care what id is queried.
--
-- Both bugs are real and independent; this migration only closes the first
-- (RLS policy gaps). Fixing only the wedding id without this migration would
-- still leave any of the eight zero-coverage tables above blank; fixing only
-- this migration without the wedding id would still resolve nothing, because
-- the id the app queries doesn't exist as a row.
--
-- SCOPE
-- Read-only (SELECT), anon role, gated to `venue_id`/`wedding_id` belonging
-- to a venue with `is_demo = true`. Same predicate shape as mig 064/383.
-- `user_profiles` is deliberately excluded — mig 064/383 both exclude it
-- (its own policies self-reference user_profiles; adding a second permissive
-- policy risks the recursion mig 383's header warns about), and demo mode
-- never queries it (`isDemoMode()` short-circuits with a hardcoded coordinator
-- before any user_profiles read — see auth-helpers.ts getPlatformAuth/
-- getCoupleAuth). `consumer_requests` is excluded too: it's scoped by
-- `requester_user_id = auth.uid()`, not venue_id/wedding_id, and the one
-- couple-portal page that reads it (privacy/page.tsx) bails out before
-- querying when there's no real Supabase auth session, which demo visitors
-- never have.
--
-- NOT COVERED BY THIS MIGRATION: the Storage buckets `couple-photos`,
-- `inspo-gallery`, `vendor-contracts`, `venue-assets`. Couple pages read
-- those via `supabase.storage.from(...)`, a different policy surface
-- (`storage.objects` policies), not `public.<table>` RLS. If demo photo/
-- inspo/downloads pages are also blank, that's a follow-up outside this
-- migration's remit (SQL table policies only).
--
-- IDEMPOTENCY — every ALTER/DROP/CREATE is safe to rerun. Table-existence
-- and column-existence are checked at execution time via information_schema,
-- matching the pattern in mig 064/383 (some listed tables may not exist in
-- every environment).
--
-- APPLICATION — operator runs this in the Supabase SQL editor against
-- production, same as 064/383 (no DATABASE_URL configured for CLI push from
-- this workstation). This workstream (W4) does not run it — see
-- NOVEMBER-PLAN.md "no database writes" rule.
-- ============================================================================

-- ============================================================================
-- STEP 1: demo_anon_select_<table> on every couple-portal-read table.
-- venue_id preferred when present (matches mig 064 Step 1 ordering); falls
-- back to a wedding_id -> weddings.venue_id join otherwise (mig 064 Step 2
-- shape). Tables with neither column, or that don't exist in this
-- environment, are skipped with a NOTICE rather than failing the migration.
-- ============================================================================
DO $$
DECLARE
  demo_tables text[] := ARRAY[
    'accommodations', 'admin_notifications', 'allergy_registry', 'bar_planning',
    'bar_recipes', 'bar_shopping_list', 'bedroom_assignments', 'booked_vendors',
    'borrow_catalog', 'borrow_selections', 'brand_assets', 'budget_items',
    'budget_payments', 'ceremony_chair_plans', 'ceremony_order', 'checklist_items',
    'contracts', 'day_of_media', 'decor_inventory', 'guest_care_notes',
    'guest_list', 'guest_meal_options', 'guest_tag_assignments', 'guest_tags',
    'inspo_gallery', 'interactions', 'makeup_schedule', 'messages',
    'onboarding_progress', 'packages', 'people', 'photo_library',
    'rehearsal_dinner', 'rsvp_config', 'sage_conversations', 'seating_tables',
    'section_finalisations', 'shuttle_schedule', 'staffing_assignments', 'storefront',
    'table_map_layouts', 'timeline', 'vendor_recommendations', 'venue_ai_config',
    'venue_assets', 'venue_availability', 'venue_config', 'wedding_config',
    'wedding_detail_config', 'wedding_details', 'wedding_party', 'wedding_tables',
    'wedding_website_settings', 'wedding_worksheets'
  ];
  t text;
  has_venue boolean;
  has_wedding boolean;
BEGIN
  FOREACH t IN ARRAY demo_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      RAISE NOTICE '[392] skip, table does not exist in this environment: %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t AND column_name = 'venue_id'
    ) INTO has_venue;
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = t AND column_name = 'wedding_id'
    ) INTO has_wedding;

    -- %I on the concatenated name (not %s inside manual quotes) so Postgres
    -- quotes the whole policy identifier correctly regardless of table name
    -- shape, matching the pattern mig 064/383 use for every other identifier.
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', 'demo_anon_select_' || t, t);

    IF has_venue THEN
      EXECUTE format(
        $p$CREATE POLICY %I ON public.%I
          FOR SELECT TO anon
          USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true))$p$,
        'demo_anon_select_' || t, t
      );
    ELSIF has_wedding THEN
      EXECUTE format(
        $p$CREATE POLICY %I ON public.%I
          FOR SELECT TO anon
          USING (wedding_id IN (
            SELECT id FROM public.weddings
            WHERE venue_id IN (SELECT id FROM public.venues WHERE is_demo = true)
          ))$p$,
        'demo_anon_select_' || t, t
      );
    ELSE
      RAISE NOTICE '[392] skip, no venue_id or wedding_id column: %', t;
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- STEP 2: venues / weddings themselves. Re-asserts mig 064 steps 3-4 —
-- belt-and-braces, harmless if already present (DROP IF EXISTS + CREATE).
-- ============================================================================
DROP POLICY IF EXISTS "venues_demo_anon_select" ON public.venues;
CREATE POLICY "venues_demo_anon_select" ON public.venues
  FOR SELECT TO anon
  USING (is_demo = true);

DROP POLICY IF EXISTS "weddings_demo_anon_select" ON public.weddings;
CREATE POLICY "weddings_demo_anon_select" ON public.weddings
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ============================================================================
-- STEP 3: data fixes. Every statement below is scoped to the four Crestwood
-- demo venue ids only (see src/lib/api/auth-helpers.ts DEMO_VENUE_ALLOWLIST).
-- ============================================================================

-- 3a. Hawthorne's business_name is 'Rixey Manor' in venue_config — leftover
-- from a copy/paste against the real Rixey Manor row (finding 1's visible
-- symptom: the couple-portal header reads "Rixey Manor"). One venue, one row.
UPDATE public.venue_config
   SET business_name = 'Hawthorne Manor',
       updated_at = now()
 WHERE venue_id = '22222222-2222-2222-2222-222222222201'
   AND business_name IS DISTINCT FROM 'Hawthorne Manor';

-- 3b. Demo venue_ai_config.escalation_email is sarah@rixeymanor.com — a REAL,
-- live inbox at Isadora's actual venue, not a fictional address (finding 5).
-- A demo visitor following Sage's footer "or email <addr> directly" would
-- reach Rixey's real ops inbox. Replace with the venue's own fictional
-- coordinator address, already established in supabase/seed.sql
-- (venue_config.coordinator_email = 'sarah@hawthornemanor.com' for Hawthorne)
-- so the footer stays internally consistent rather than inventing a new
-- address. Scoped to the four demo venues and only touches rows that are
-- currently pointed at the real rixeymanor.com domain.
UPDATE public.venue_ai_config
   SET escalation_email = 'sarah@hawthornemanor.com',
       updated_at = now()
 WHERE venue_id IN (
     '22222222-2222-2222-2222-222222222201',
     '22222222-2222-2222-2222-222222222202',
     '22222222-2222-2222-2222-222222222203',
     '22222222-2222-2222-2222-222222222204'
   )
   AND escalation_email ILIKE '%@rixeymanor.com';

-- 3c. Diagnostic test rows. Some prior gap-audit run left rows named like
-- "SarahH[DIAG-GAP3]" / "Couple[DIAG-GAP3]" in the demo venue's couples and
-- people tables (finding 4). Delete them; scoped to the four demo venues and
-- to the literal '[DIAG' marker so nothing else is touched.
DELETE FROM public.couples
 WHERE venue_id IN (
     '22222222-2222-2222-2222-222222222201',
     '22222222-2222-2222-2222-222222222202',
     '22222222-2222-2222-2222-222222222203',
     '22222222-2222-2222-2222-222222222204'
   )
   AND (
     primary_contact_name ILIKE '%[DIAG%'
     OR partner_contact_name ILIKE '%[DIAG%'
   );

DELETE FROM public.people
 WHERE venue_id IN (
     '22222222-2222-2222-2222-222222222201',
     '22222222-2222-2222-2222-222222222202',
     '22222222-2222-2222-2222-222222222203',
     '22222222-2222-2222-2222-222222222204'
   )
   AND (
     first_name ILIKE '%[DIAG%'
     OR last_name ILIKE '%[DIAG%'
   );

-- NOT fixed here: relay addresses (projects@honeybook.com,
-- notifications@calendly.com) showing as a couple's contact email, and the
-- spine `touchpoints` table having 0 rows for the demo venue while the
-- legacy tables are populated (finding 4, second half). Both are identity-
-- resolution gaps that need the demo data reseeded THROUGH linkSignal, not a
-- data patch — see DEMO-RESEED-DESIGN.md written alongside this migration.
-- A one-off UPDATE here would just be a second wrong answer sitting next to
-- the first one it's supposed to replace.

-- ============================================================================
-- POST-MIGRATION VERIFICATION (operator, after running in the SQL editor)
-- 1. Visit /demo -> Couple Portal -> /couple/hawthorne-manor/. Header should
--    read "Hawthorne Manor", not "Rixey Manor" (needs the DEMO_WEDDING_ID
--    code fix in the same workstream's report to also be deployed, or the
--    portal will still show the header fix but keep the checklist empty —
--    they are two different bugs, see the audit trail above).
-- 2. `SELECT policyname, tablename FROM pg_policies WHERE schemaname='public'
--    AND roles = '{anon}' AND policyname LIKE 'demo_anon_select%' ORDER BY 2;`
--    should list all 54 tables from the STEP 1 array that exist in this
--    environment (check the NOTICEs from the run for any skipped).
-- 3. `SELECT id, business_name FROM venue_config WHERE venue_id =
--    '22222222-2222-2222-2222-222222222201';` -> 'Hawthorne Manor'.
-- 4. `SELECT venue_id, escalation_email FROM venue_ai_config WHERE venue_id
--    IN (four demo ids);` -> none should show @rixeymanor.com.
-- 5. `SELECT count(*) FROM couples WHERE venue_id IN (four demo ids) AND
--    (primary_contact_name ILIKE '%[DIAG%' OR partner_contact_name ILIKE
--    '%[DIAG%');` -> 0. Same query against `people` -> 0.
-- ============================================================================
