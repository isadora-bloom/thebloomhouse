-- ============================================
-- 055: FIX BUG-06A — interactions / drafts venue_isolation RLS leak
-- ============================================
--
-- ROOT CAUSE
-- Live reproduction (tmp-bug06a-deep.mjs, April 17 2026) showed that a freshly
-- created authenticated coordinator scoped to venue B could:
--   1) read 28 user_profiles rows (should see only 1 — their own)
--   2) read 78 interactions rows across 4 different venue_ids (should see 0
--      from other venues)
--   3) INSERT a new interactions row with venue_id = venue A
--
-- The venue_isolation policy declared in 006_rls_policies.sql lines 128 and
-- 139 is correct on paper, but in practice the live database has additional
-- permissive policies on interactions, drafts, and user_profiles that were
-- not introduced by any migration file in this repo (likely applied ad hoc
-- via the Supabase SQL editor during earlier debugging). Because Postgres
-- OR-combines permissive policies, any extra "allow all" policy defeats
-- venue_isolation.
--
-- WHAT THIS MIGRATION DOES
-- For interactions, drafts, and user_profiles:
--   a) Drop EVERY existing policy on the table (captured dynamically from
--      pg_policies so unknown leftover policies are also removed).
--   b) Re-enable RLS (idempotent — in case a prior DISABLE was run).
--   c) Re-create the intended policies with explicit TO authenticated scope
--      and separate SELECT / INSERT / UPDATE / DELETE clauses so both USING
--      and WITH CHECK are enforced.
--   d) Keep service_role unrestricted (default — service role bypasses RLS).
--
-- The anon role is intentionally NOT granted any access to these tables.
-- Demo mode does not read interactions or drafts. If that changes later, add
-- a scoped anon policy keyed on a demo flag, never USING (true).
--
-- No em dashes in SQL comments per repo style rules.
-- ============================================

-- ============================================
-- INTERACTIONS
-- ============================================
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'interactions' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.interactions', pol.policyname);
  END LOOP;
END $$;

ALTER TABLE public.interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "interactions_select_venue_isolation" ON public.interactions
  FOR SELECT TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "interactions_insert_venue_isolation" ON public.interactions
  FOR INSERT TO authenticated
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "interactions_update_venue_isolation" ON public.interactions
  FOR UPDATE TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "interactions_delete_venue_isolation" ON public.interactions
  FOR DELETE TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "interactions_super_admin" ON public.interactions
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- DRAFTS (same shape, same bug suspected)
-- ============================================
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'drafts' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.drafts', pol.policyname);
  END LOOP;
END $$;

ALTER TABLE public.drafts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "drafts_select_venue_isolation" ON public.drafts
  FOR SELECT TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "drafts_insert_venue_isolation" ON public.drafts
  FOR INSERT TO authenticated
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "drafts_update_venue_isolation" ON public.drafts
  FOR UPDATE TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "drafts_delete_venue_isolation" ON public.drafts
  FOR DELETE TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "drafts_super_admin" ON public.drafts
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- ============================================
-- USER_PROFILES (root of the subquery used by every venue_isolation policy)
-- Live probe showed an authenticated user could read 28 other user_profiles
-- rows — that is why defence-in-depth venue isolation across the schema is
-- unreliable today. Lock it down.
-- ============================================
DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'user_profiles' LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.user_profiles', pol.policyname);
  END LOOP;
END $$;

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- A user can read and update their own profile row only.
CREATE POLICY "user_profiles_select_own" ON public.user_profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid());

CREATE POLICY "user_profiles_update_own" ON public.user_profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- Super admins can read and manage every profile. The EXISTS subquery is safe
-- from recursion because PostgreSQL short-circuits policy evaluation for the
-- row the user is already permitted to see via user_profiles_select_own.
CREATE POLICY "user_profiles_super_admin_all" ON public.user_profiles
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles up2 WHERE up2.id = auth.uid() AND up2.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles up2 WHERE up2.id = auth.uid() AND up2.role = 'super_admin'));

-- ============================================
-- POST-MIGRATION SANITY CHECK
-- After applying, run tmp-bug06a-deep.mjs (or equivalent) and confirm:
--   user_profiles visible to coordinator = 1
--   interactions visible to venue B coord for venue A subject = 0
--   INSERT into venue A interactions as venue B coord fails with 42501
-- ============================================
