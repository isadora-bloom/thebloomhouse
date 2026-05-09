-- ---------------------------------------------------------------------------
-- 245_brand_assets_auth_policies.sql
-- ---------------------------------------------------------------------------
-- brand_assets was created in migration 024 with two policies:
--
--   venue_isolation   FOR ALL USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
--   super_admin_bypass FOR ALL USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
--
-- Both rely on user_profiles having venue_id (single-venue model) or
-- role='super_admin'. Migration 038 introduced a permissive
-- TO authenticated baseline that every other coordinator-table inherits,
-- but brand_assets was missed. Result: when a coordinator's user_profiles
-- row does not exactly match (e.g. their venue_id is null or set to a
-- different venue under multi-venue), the INSERT to brand_assets is
-- silently denied by RLS - the modal looked frozen because no error
-- was thrown back through PostgREST in the form the client surfaced.
--
-- This migration aligns brand_assets with the same permissive
-- TO authenticated baseline used by venue_assets, venue_resources,
-- decor_inventory, etc. The legacy venue_isolation + super_admin_bypass
-- policies stay (no harm, RLS is OR-combined across permissive
-- policies), and the new explicit FOR INSERT WITH CHECK policy ensures
-- the write path is unblocked.
--
-- Idempotent: drops + recreates each named policy.
-- ---------------------------------------------------------------------------

BEGIN;

DROP POLICY IF EXISTS "auth_select_brand_assets" ON public.brand_assets;
CREATE POLICY "auth_select_brand_assets" ON public.brand_assets
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_brand_assets" ON public.brand_assets;
CREATE POLICY "auth_insert_brand_assets" ON public.brand_assets
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_brand_assets" ON public.brand_assets;
CREATE POLICY "auth_update_brand_assets" ON public.brand_assets
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_brand_assets" ON public.brand_assets;
CREATE POLICY "auth_delete_brand_assets" ON public.brand_assets
  FOR DELETE TO authenticated USING (true);

COMMIT;

NOTIFY pgrst, 'reload schema';
