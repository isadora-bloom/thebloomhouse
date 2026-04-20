-- ============================================================================
-- Migration 058: Add write policies so org_admins can run /setup and
--                /onboarding from the browser client
-- ============================================================================
--
-- Migration 056 installed SELECT policies on venues and organisations, and
-- a super_admin_all policy, but NO insert/update/delete policies for
-- regular org_admins. Result: a freshly-signed-up coordinator on /setup
-- hits:
--   "new row violates row-level security policy for table \"venues\""
-- when trying to create their first venue, because the browser client
-- uses their authed session, not service role.
--
-- Same problem applies to:
--   - organisations  (saveCompany updates the org name)
--   - venue_config   (createVenue inserts a config row for the new venue,
--                     but user_profiles.venue_id is still null/old)
--
-- Fix: allow INSERT/UPDATE/DELETE from any authed user whose
-- user_profiles.org_id matches the target row's org_id. For venue_config,
-- match via venues.org_id since venue_config itself doesn't carry org_id.
-- ============================================================================

-- ─── venues: allow org members to INSERT/UPDATE/DELETE within their org ─────
DROP POLICY IF EXISTS "venues_org_insert" ON public.venues;
DROP POLICY IF EXISTS "venues_org_update" ON public.venues;
DROP POLICY IF EXISTS "venues_org_delete" ON public.venues;

CREATE POLICY "venues_org_insert" ON public.venues
  FOR INSERT TO authenticated
  WITH CHECK (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "venues_org_update" ON public.venues
  FOR UPDATE TO authenticated
  USING (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

CREATE POLICY "venues_org_delete" ON public.venues
  FOR DELETE TO authenticated
  USING (org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

-- ─── organisations: allow owning user to UPDATE their own org ───────────────
DROP POLICY IF EXISTS "organisations_update_own" ON public.organisations;
CREATE POLICY "organisations_update_own" ON public.organisations
  FOR UPDATE TO authenticated
  USING (id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid()));

-- ─── venue_config: allow org members to INSERT/UPDATE/DELETE for any venue
-- in their org. venue_config has no org_id column, so we join via venues.
-- The existing venue_scope_select policy from 056 already allows SELECT
-- based on user_profiles.venue_id; we add the broader org-based writes.
-- ───────────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "venue_config_org_insert" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_update" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_delete" ON public.venue_config;
DROP POLICY IF EXISTS "venue_config_org_select" ON public.venue_config;

-- Also broaden SELECT so an org_admin can read venue_config for any venue
-- in their org (not just profile.venue_id). This is needed for onboarding
-- to read back the config row they just inserted.
CREATE POLICY "venue_config_org_select" ON public.venue_config
  FOR SELECT TO authenticated
  USING (venue_id IN (
    SELECT id FROM public.venues
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "venue_config_org_insert" ON public.venue_config
  FOR INSERT TO authenticated
  WITH CHECK (venue_id IN (
    SELECT id FROM public.venues
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "venue_config_org_update" ON public.venue_config
  FOR UPDATE TO authenticated
  USING (venue_id IN (
    SELECT id FROM public.venues
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ))
  WITH CHECK (venue_id IN (
    SELECT id FROM public.venues
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ));

CREATE POLICY "venue_config_org_delete" ON public.venue_config
  FOR DELETE TO authenticated
  USING (venue_id IN (
    SELECT id FROM public.venues
    WHERE org_id = (SELECT org_id FROM public.user_profiles WHERE id = auth.uid())
  ));

-- Reload PostgREST schema
NOTIFY pgrst, 'reload schema';
