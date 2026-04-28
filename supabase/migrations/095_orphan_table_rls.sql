-- ---------------------------------------------------------------------------
-- 095_orphan_table_rls.sql
-- ---------------------------------------------------------------------------
-- Add coordinator-side authenticated RLS policies to four tables that
-- the 2026-04-28 audit found shipping with anon-only policies. These
-- are the tables we're adding coordinator UIs to in the same PR
-- (storefront, borrow_catalog, borrow_selections, venue_resources):
-- without authenticated venue_isolation, the new UIs would 403 when
-- inserting/updating, even though the user is logged in.
--
-- Pattern matches the rest of the schema (006_rls_policies.sql):
--   - venue_isolation FOR ALL — venue_id matches the caller's profile
--   - super_admin_bypass FOR ALL — super admins reach everything
--   - existing anon policies stay in place (the demo and the public
--     wedding-website route still need anon SELECT)
-- ---------------------------------------------------------------------------

-- storefront -----------------------------------------------------------------

ALTER TABLE public.storefront ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.storefront;
CREATE POLICY "venue_isolation" ON public.storefront
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.storefront;
CREATE POLICY "super_admin_bypass" ON public.storefront
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- borrow_catalog -------------------------------------------------------------

ALTER TABLE public.borrow_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.borrow_catalog;
CREATE POLICY "venue_isolation" ON public.borrow_catalog
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.borrow_catalog;
CREATE POLICY "super_admin_bypass" ON public.borrow_catalog
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- borrow_selections ----------------------------------------------------------

ALTER TABLE public.borrow_selections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.borrow_selections;
CREATE POLICY "venue_isolation" ON public.borrow_selections
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.borrow_selections;
CREATE POLICY "super_admin_bypass" ON public.borrow_selections
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- venue_resources ------------------------------------------------------------

ALTER TABLE public.venue_resources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "venue_isolation" ON public.venue_resources;
CREATE POLICY "venue_isolation" ON public.venue_resources
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM public.user_profiles WHERE id = auth.uid()));

DROP POLICY IF EXISTS "super_admin_bypass" ON public.venue_resources;
CREATE POLICY "super_admin_bypass" ON public.venue_resources
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

NOTIFY pgrst, 'reload schema';
