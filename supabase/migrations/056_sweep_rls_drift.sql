-- ============================================
-- 056: SWEEP RLS DRIFT - close BUG-06A at scale
-- ============================================
--
-- WHY THIS EXISTS
-- Migration 055 fixed venue isolation RLS on three tables (interactions,
-- drafts, user_profiles) after a live reproduction showed extra permissive
-- policies had been added ad hoc via the Supabase SQL editor during prior
-- debugging. Those extra policies were not captured in any migration file,
-- and because Postgres OR combines permissive policies, any stray
-- USING (true) policy defeats venue isolation for that table.
--
-- This migration applies the same cleanup at schema scale. For every table
-- in the public schema that has a venue_id, wedding_id, or org_id column it
-- drops ALL existing policies (captured dynamically from pg_policies) and
-- re-creates a canonical set:
--   FOR SELECT / INSERT / UPDATE / DELETE TO authenticated
--   USING + WITH CHECK on the scope column via user_profiles.venue_id
--   plus a super_admin bypass
--
-- IDEMPOTENCY
-- Safe to rerun. Each section drops every existing policy on its target
-- tables before re-creating them. No CREATE POLICY uses IF NOT EXISTS
-- (Postgres does not support it) but the preceding DROP loop makes the
-- net effect idempotent.
--
-- APPLICATION
-- Run manually in the Supabase SQL editor against the production project.
-- No DATABASE_URL is configured in .env.local, so CLI push is not available
-- from this workstation. After applying, rerun tmp-bug06a-deep.mjs (or an
-- equivalent probe) to confirm cross-venue reads / inserts are denied.
--
-- THE THREE SHAPES HANDLED
--   1. venue_id-scoped tables
--        isolation key is venue_id = user_profiles.venue_id
--   2. wedding_id-only tables (no venue_id column)
--        isolation key is wedding_id IN (SELECT id FROM weddings WHERE
--        venue_id = user_profiles.venue_id). Couple users work here too
--        because their user_profiles.venue_id is set by the seed helper
--        and equals weddings.venue_id for their wedding row.
--   3. org_id-only tables (no venue_id and no wedding_id)
--        isolation key is org_id = user_profiles.org_id
--
-- TABLES EXCLUDED FROM THE GENERIC LOOPS
--   organisations, venues, user_profiles, weddings - these are the isolation
--   sources themselves and get bespoke policies below.
--   venue_groups, venue_group_members - managed by org_admin / super_admin
--   via organisations membership. Handled in the org_id loop for venue_groups
--   and as a special case for venue_group_members (no tenancy column but
--   joins through venue_groups.org_id).
--   team_invitations - org-scoped; handled in org_id loop. The earlier
--   USING (true) policy is dropped.
--   api_costs - venue_id nullable. Writers are service role (bypass RLS).
--   Authenticated reads require venue_id match OR null (platform-level costs
--   visible only to super_admin).
--   activity_log, admin_notifications - venue_id scoped, writers are service
--   role. Handled in the venue_id loop with standard scope. Super_admin
--   bypass grants platform-wide visibility.
--   market_intelligence, industry_benchmarks - pure reference tables with
--   no tenancy. Intentionally skipped (existing authenticated read-all
--   policies from 042 remain).
--   rate_limits, stripe_events - platform-level, no tenancy. Skipped.
--
-- TODO verify
--   booked_dates has venue_id nullable; after this migration a row with
--   venue_id IS NULL will be invisible to any authenticated role. Confirm
--   seed / real data always sets venue_id. Leaving the default strict policy.
--   error_logs has venue_id nullable; same caveat as booked_dates.
--
-- No em dashes per repo style rules.
-- ============================================

-- ============================================
-- STEP 1: Drop ALL existing policies on every scoped table.
-- Captures unknown leftover policies that were added via the Supabase SQL
-- editor and never committed to git.
-- ============================================
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT DISTINCT p.tablename, p.policyname
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename IN (
        SELECT DISTINCT c.table_name
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.column_name IN ('venue_id', 'wedding_id', 'org_id')
      )
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- Also drop policies on the four isolation source tables, handled below.
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename IN ('organisations', 'venues', 'user_profiles', 'weddings', 'venue_group_members')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- ============================================
-- STEP 2: Ensure RLS is ENABLED on every tenancy-bearing table.
-- ============================================
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name IN ('venue_id', 'wedding_id', 'org_id')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.table_name);
  END LOOP;
END $$;

ALTER TABLE public.organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.weddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.venue_group_members ENABLE ROW LEVEL SECURITY;

-- ============================================
-- STEP 3: Canonical policies for venue_id-scoped tables.
-- Excludes the special-case tables handled below.
-- ============================================
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT table_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND column_name = 'venue_id'
      AND table_name NOT IN (
        'venues',
        'user_profiles',
        'organisations',
        'weddings',
        'interactions',      -- handled in 055
        'drafts',            -- handled in 055
        'venue_group_members', -- special case below
        'team_invitations',  -- org-scoped, handled in org_id loop
        'api_costs'          -- special case below
      )
  LOOP
    EXECUTE format($p$CREATE POLICY "venue_scope_select" ON public.%I
      FOR SELECT TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "venue_scope_insert" ON public.%I
      FOR INSERT TO authenticated
      WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "venue_scope_update" ON public.%I
      FOR UPDATE TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
      WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "venue_scope_delete" ON public.%I
      FOR DELETE TO authenticated
      USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "super_admin_all" ON public.%I
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))$p$, t.table_name);
  END LOOP;
END $$;

-- ============================================
-- STEP 4: Canonical policies for wedding_id-only tables.
-- Resolves venue via weddings.venue_id. Couples read their own because
-- their user_profiles.venue_id matches weddings.venue_id.
-- ============================================
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'wedding_id'
      AND c.table_name NOT IN ('weddings')
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns c2
        WHERE c2.table_schema = 'public'
          AND c2.table_name = c.table_name
          AND c2.column_name = 'venue_id'
      )
  LOOP
    EXECUTE format($p$CREATE POLICY "wedding_scope_select" ON public.%I
      FOR SELECT TO authenticated
      USING (wedding_id IN (
        SELECT id FROM public.weddings
        WHERE venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid())
      ))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "wedding_scope_insert" ON public.%I
      FOR INSERT TO authenticated
      WITH CHECK (wedding_id IN (
        SELECT id FROM public.weddings
        WHERE venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid())
      ))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "wedding_scope_update" ON public.%I
      FOR UPDATE TO authenticated
      USING (wedding_id IN (
        SELECT id FROM public.weddings
        WHERE venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid())
      ))
      WITH CHECK (wedding_id IN (
        SELECT id FROM public.weddings
        WHERE venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid())
      ))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "wedding_scope_delete" ON public.%I
      FOR DELETE TO authenticated
      USING (wedding_id IN (
        SELECT id FROM public.weddings
        WHERE venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid())
      ))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "super_admin_all" ON public.%I
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))$p$, t.table_name);
  END LOOP;
END $$;

-- ============================================
-- STEP 5: Canonical policies for org_id-only tables (no venue_id, no
-- wedding_id). Isolation key is user_profiles.org_id.
-- Includes team_invitations (originally USING (true), now strict).
-- ============================================
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT DISTINCT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name = 'org_id'
      AND c.table_name NOT IN ('organisations', 'user_profiles', 'venues')
      AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns c2
        WHERE c2.table_schema = 'public'
          AND c2.table_name = c.table_name
          AND c2.column_name IN ('venue_id', 'wedding_id')
      )
  LOOP
    EXECUTE format($p$CREATE POLICY "org_scope_select" ON public.%I
      FOR SELECT TO authenticated
      USING (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "org_scope_insert" ON public.%I
      FOR INSERT TO authenticated
      WITH CHECK (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "org_scope_update" ON public.%I
      FOR UPDATE TO authenticated
      USING (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()))
      WITH CHECK (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "org_scope_delete" ON public.%I
      FOR DELETE TO authenticated
      USING (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()))$p$, t.table_name);

    EXECUTE format($p$CREATE POLICY "super_admin_all" ON public.%I
      FOR ALL TO authenticated
      USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
      WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))$p$, t.table_name);
  END LOOP;
END $$;

-- ============================================
-- STEP 6: Special case - user_profiles
-- A user can read and update only their own row. Super_admin manages all.
-- Matches the policies installed by 055; re-stated here because step 1
-- dropped them.
-- ============================================
CREATE POLICY "user_profiles_select_own" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "user_profiles_update_own" ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

CREATE POLICY "user_profiles_super_admin_all" ON public.user_profiles
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up2 WHERE up2.id = auth.uid() AND up2.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up2 WHERE up2.id = auth.uid() AND up2.role = 'super_admin'));

-- ============================================
-- STEP 7: Special case - venues
-- A user reads the venue row whose id matches their user_profiles.venue_id,
-- or any venue in their org_id. Super_admin manages all.
-- ============================================
CREATE POLICY "venues_select_own" ON public.venues
  FOR SELECT TO authenticated
  USING (
    id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid())
    OR org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  );

CREATE POLICY "venues_super_admin_all" ON public.venues
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- STEP 8: Special case - organisations
-- A user reads their own organisation. Super_admin manages all.
-- ============================================
CREATE POLICY "organisations_select_own" ON public.organisations
  FOR SELECT TO authenticated
  USING (id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "organisations_super_admin_all" ON public.organisations
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- STEP 9: Special case - weddings
-- weddings has venue_id. Normally the venue_id loop in step 3 would cover
-- it, but we handle it explicitly so the wedding_scope_* policies in step
-- 4 have a deterministic reference.
-- ============================================
CREATE POLICY "weddings_select_venue" ON public.weddings
  FOR SELECT TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "weddings_insert_venue" ON public.weddings
  FOR INSERT TO authenticated
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "weddings_update_venue" ON public.weddings
  FOR UPDATE TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "weddings_delete_venue" ON public.weddings
  FOR DELETE TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "weddings_super_admin_all" ON public.weddings
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- STEP 10: Special case - venue_group_members
-- No tenancy column, but membership is controlled through venue_groups.org_id.
-- Users see members of groups in their org. Super_admin bypass.
-- ============================================
CREATE POLICY "venue_group_members_select" ON public.venue_group_members
  FOR SELECT TO authenticated
  USING (group_id IN (
    SELECT id FROM public.venue_groups
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "venue_group_members_insert" ON public.venue_group_members
  FOR INSERT TO authenticated
  WITH CHECK (group_id IN (
    SELECT id FROM public.venue_groups
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "venue_group_members_update" ON public.venue_group_members
  FOR UPDATE TO authenticated
  USING (group_id IN (
    SELECT id FROM public.venue_groups
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ))
  WITH CHECK (group_id IN (
    SELECT id FROM public.venue_groups
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "venue_group_members_delete" ON public.venue_group_members
  FOR DELETE TO authenticated
  USING (group_id IN (
    SELECT id FROM public.venue_groups
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "venue_group_members_super_admin_all" ON public.venue_group_members
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- STEP 11: Special case - api_costs
-- venue_id is nullable (platform-level AI calls have no venue). Writers are
-- service role (bypass RLS). Authenticated reads limited to own venue.
-- Rows with venue_id IS NULL are visible only to super_admin.
-- ============================================
CREATE POLICY "api_costs_select_venue" ON public.api_costs
  FOR SELECT TO authenticated
  USING (
    venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid())
  );

CREATE POLICY "api_costs_super_admin_all" ON public.api_costs
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- STEP 12: Special case - team_invitations
-- org_id-scoped already covered by the org_id loop in step 5, but the prior
-- migration 049 installed an ANON select policy and a permissive
-- USING (true) authenticated policy. Both were dropped in step 1. The loop
-- in step 5 re-created strict org-scoped policies. No extra policy added
-- here; this section is a landing spot for the audit trail.
-- ============================================

-- ============================================
-- POST-MIGRATION VERIFICATION CHECKLIST
-- After applying via the Supabase SQL editor:
--   1. Rerun tmp-bug06a-deep.mjs and confirm cross-venue reads / inserts
--      return 0 rows or fail with RLS error 42501.
--   2. Log in as a couple user and confirm they can read their own
--      wedding, guest_list, timeline, budget, etc.
--   3. Log in as a coordinator for venue A and confirm they cannot see
--      any rows for venue B.
--   4. Confirm the super_admin role still has platform-wide visibility.
--   5. Confirm service role writes (agent pipeline, cron jobs) still
--      succeed - service_role bypasses RLS by default in Supabase.
-- ============================================
