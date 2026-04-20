-- ============================================================================
-- Migration 057: Fix infinite recursion in user_profiles RLS +
--                Fix overly-permissive team_invitations RLS
-- ============================================================================
--
-- PART 1 - Recursion
--
-- Migration 056 installed a `super_admin_all` policy on user_profiles that
-- does:
--   USING (EXISTS (SELECT 1 FROM public.user_profiles up2 WHERE up2.id = auth.uid() AND up2.role = 'super_admin'))
--
-- When any authed query touches user_profiles - directly, or indirectly via
-- another table's RLS subquery like `SELECT venue_id FROM user_profiles
-- WHERE id = auth.uid()` - PostgreSQL evaluates ALL permissive policies and
-- OR's them. Evaluating the super_admin_all USING runs a SELECT on
-- user_profiles, which triggers RLS again, which evaluates super_admin_all
-- again, which queries user_profiles... Postgres detects and aborts with
-- "infinite recursion detected in policy for relation user_profiles".
--
-- Fix: wrap the super-admin check in a SECURITY DEFINER function that
-- bypasses RLS. The function is STABLE and read-only, so it's safe.
--
-- PART 2 - team_invitations
--
-- Migration 049 installed two overly permissive policies:
--   - auth_all_invitations:    FOR ALL TO authenticated USING (true)
--   - anon_select_invitations: FOR SELECT TO anon USING (true)   <-- token leak
--
-- Migration 056's generic loops EXCLUDED team_invitations (venue_scope NOT IN
-- list + org_scope excludes tables that have venue_id). Result: the old
-- policies are still in place. Replace them with org-scoped policies.
-- ============================================================================

-- ─── Helper: SECURITY DEFINER super-admin check ─────────────────────────────
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated;

-- ─── Replace every super_admin_all policy with a recursion-free version ─────
-- pg_policies captures the current state. For each policy named
-- super_admin_all (installed by 056 on many tables), drop and recreate using
-- the helper function.
DO $$
DECLARE
  rec record;
BEGIN
  FOR rec IN
    SELECT tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname = 'super_admin_all'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS super_admin_all ON public.%I', rec.tablename);
    EXECUTE format($p$CREATE POLICY "super_admin_all" ON public.%I
      FOR ALL TO authenticated
      USING (public.is_super_admin())
      WITH CHECK (public.is_super_admin())$p$, rec.tablename);
  END LOOP;
END $$;

-- Special-named super-admin policies created in 056 for the bespoke tables
-- (user_profiles, venues, organisations, weddings, venue_group_members).
-- These have unique names, not super_admin_all, so the loop above missed
-- them.
DROP POLICY IF EXISTS "user_profiles_super_admin_all"       ON public.user_profiles;
CREATE POLICY "user_profiles_super_admin_all" ON public.user_profiles
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "venues_super_admin_all"              ON public.venues;
CREATE POLICY "venues_super_admin_all" ON public.venues
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "organisations_super_admin_all"       ON public.organisations;
CREATE POLICY "organisations_super_admin_all" ON public.organisations
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "weddings_super_admin_all"            ON public.weddings;
CREATE POLICY "weddings_super_admin_all" ON public.weddings
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

DROP POLICY IF EXISTS "venue_group_members_super_admin_all" ON public.venue_group_members;
CREATE POLICY "venue_group_members_super_admin_all" ON public.venue_group_members
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- ─── team_invitations: replace 049's lax policies with org-scoped ones ──────
DROP POLICY IF EXISTS "auth_all_invitations"    ON public.team_invitations;
DROP POLICY IF EXISTS "anon_select_invitations" ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_select"         ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_insert"         ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_update"         ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_org_delete"         ON public.team_invitations;
DROP POLICY IF EXISTS "team_invitations_super_admin_all"    ON public.team_invitations;

CREATE POLICY "team_invitations_org_select" ON public.team_invitations
  FOR SELECT TO authenticated
  USING (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "team_invitations_org_insert" ON public.team_invitations
  FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "team_invitations_org_update" ON public.team_invitations
  FOR UPDATE TO authenticated
  USING (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "team_invitations_org_delete" ON public.team_invitations
  FOR DELETE TO authenticated
  USING (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "team_invitations_super_admin_all" ON public.team_invitations
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

-- The /join route uses the service client (bypasses RLS) for token lookup,
-- so anon SELECT is not needed. Any public token lookup should go through
-- a SECURITY DEFINER RPC, not a broad anon policy.

-- Reload the PostgREST schema so the new policies take effect immediately.
NOTIFY pgrst, 'reload schema';
