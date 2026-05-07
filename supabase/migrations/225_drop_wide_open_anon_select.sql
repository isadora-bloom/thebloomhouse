-- ============================================================================
-- 225: DROP WIDE-OPEN ANON SELECT POLICIES (round-6 #2a)
--
-- Migration 027 added 49 `CREATE POLICY "anon_select_<table>" ... USING (true)`
-- policies to make the demo couple portal work back when the demo was the
-- only thing reachable. The intent was always demo-only, but the predicate
-- (`USING (true)`) leaks every row to anyone with the anon key.
--
-- Migration 064 fixed THE READ side of the demo path with narrower
-- `demo_anon_select` policies gated on `venue_id IN (is_demo=true)` /
-- `wedding_id IN (...)`. But Postgres OR's permissive policies, so the
-- wide-open 027 policies remained the actual gate; mig 064's narrowing
-- has been dead-weight ever since.
--
-- Migration 147 closed the equivalent leak on the WRITE side (anon_insert /
-- anon_update / anon_delete) but explicitly left the SELECT policies
-- untouched. Round-6 audit (2026-05-07) caught this gap; it had been live
-- as a real leak for ~3 weeks.
--
-- Why it's safe to drop now:
--   - No real (non-demo) couples are using the portal yet (Rixey is the
--     only production venue and she's coordinator-authed). Dropping these
--     SELECT policies removes anon access to all venues' couple-portal
--     data; no real user is broken.
--   - The demo path (Hawthorne / Crestwood) still works via mig 064's
--     `demo_anon_select` policies, which are scoped to `is_demo = true`.
--   - Coordinators / org_admin / super_admin all read via the
--     authenticated role, gated by mig 006's `venue_isolation` and
--     mig 058's org policies. Untouched.
--
-- After this migration, the anon role can SELECT only:
--   - rows where `venue_id` matches an is_demo venue (mig 064 step 1)
--   - rows where `wedding_id` traces to an is_demo venue (mig 064 step 2)
--   - venues / weddings / organisations / venue_groups themselves where
--     the demo flag is set (mig 064 steps 3-6)
--
-- Pre-existing wide-open SELECT policies that survive this migration are
-- listed at the bottom for human review. None should remain on
-- couple-portal-reachable tables; if any do, that's the next round of
-- this work.
-- ============================================================================

DO $$
DECLARE
  v_table text;
  v_tables text[] := ARRAY[
    -- All 49 tables touched by mig 027.
    'checklist_items',
    'guest_list',
    'seating_tables',
    'seating_assignments',
    'sage_conversations',
    'contracts',
    'messages',
    'vendor_recommendations',
    'inspo_gallery',
    'timeline',
    'venue_config',
    'venue_ai_config',
    'wedding_detail_config',
    'onboarding_progress',
    'wedding_website_settings',
    'budget_items',
    'budget_payments',
    'wedding_config',
    'couple_budget',
    'guest_meal_options',
    'guest_tags',
    'guest_tag_assignments',
    'bar_planning',
    'bar_recipes',
    'bar_shopping_list',
    'decor_inventory',
    'bedroom_assignments',
    'shuttle_schedule',
    'guest_care_notes',
    'staffing_assignments',
    'portal_section_config',
    'wedding_details',
    'wedding_tables',
    'wedding_party',
    'ceremony_order',
    'makeup_schedule',
    'rehearsal_dinner',
    'wedding_worksheets',
    'photo_library',
    'borrow_catalog',
    'borrow_selections',
    'accommodations',
    'allergy_registry',
    'rsvp_config',
    'rsvp_responses',
    'section_finalisations',
    'booked_vendors',
    'storefront',
    'venue_assets',
    'venue_resources'
  ];
BEGIN
  FOREACH v_table IN ARRAY v_tables LOOP
    -- Skip non-existent tables silently. Some may have been renamed or
    -- never created in this environment.
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = v_table
    ) THEN
      RAISE NOTICE '[225] Skipping non-existent table: %', v_table;
      CONTINUE;
    END IF;

    EXECUTE format('DROP POLICY IF EXISTS "anon_select_%I" ON public.%I', v_table, v_table);
  END LOOP;
END $$;

-- ============================================================================
-- Verification: count remaining wide-open SELECT policies on the anon role
-- across the public schema. The number should be small (or zero) and any
-- non-zero results are flagged for human review.
-- ============================================================================

DO $$
DECLARE
  v_remaining int;
  v_row record;
BEGIN
  SELECT COUNT(*) INTO v_remaining
    FROM pg_policies
   WHERE schemaname = 'public'
     AND 'anon' = ANY(roles)
     AND cmd = 'SELECT'
     AND qual = 'true';

  RAISE NOTICE '[225] Wide-open anon SELECT policies remaining on public schema: %', v_remaining;

  IF v_remaining > 0 THEN
    FOR v_row IN
      SELECT tablename, policyname
        FROM pg_policies
       WHERE schemaname = 'public'
         AND 'anon' = ANY(roles)
         AND cmd = 'SELECT'
         AND qual = 'true'
    LOOP
      RAISE NOTICE '[225] Surviving wide-open: %.%', v_row.tablename, v_row.policyname;
    END LOOP;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
