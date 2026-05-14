-- ---------------------------------------------------------------------------
-- 343_reviews_rls_lockdown.sql
-- ---------------------------------------------------------------------------
-- TIER 7a (2026-05-14). Migration 031 shipped reviews with eight wide-open
-- policies — all four CRUD verbs granted to BOTH anon AND authenticated
-- with no venue scoping. Any authenticated user could read, modify, or
-- delete any venue's reviews. anon could too. That predates the
-- multi-tenant RLS hardening but was never tightened.
--
-- This migration:
--   1. DROPs all eight legacy wide-open policies.
--   2. Adds venue-scoped SELECT for authenticated users via user_profiles.
--   3. Removes anon access entirely. The /intel/reviews/paste flow inserts
--      via the service-role client; the seed-pasted reviews are imported
--      by /api/intel/reviews/extract-from-text which already runs as
--      service-role. No anon-facing review write path exists.
--   4. Service-role bypasses RLS by default, so omitted INSERT/UPDATE/
--      DELETE policies are intentional. Operators do not directly mutate
--      reviews from the client.
--   5. super_admin bypass for cross-venue ops.
--
-- Idempotent — DROP IF EXISTS on all eight legacy policies.

DROP POLICY IF EXISTS "anon_select_reviews"          ON public.reviews;
DROP POLICY IF EXISTS "anon_insert_reviews"          ON public.reviews;
DROP POLICY IF EXISTS "anon_update_reviews"          ON public.reviews;
DROP POLICY IF EXISTS "anon_delete_reviews"          ON public.reviews;
DROP POLICY IF EXISTS "authenticated_select_reviews" ON public.reviews;
DROP POLICY IF EXISTS "authenticated_insert_reviews" ON public.reviews;
DROP POLICY IF EXISTS "authenticated_update_reviews" ON public.reviews;
DROP POLICY IF EXISTS "authenticated_delete_reviews" ON public.reviews;

-- Also drop any prior versions of the new policies if a partial re-run
-- of this migration was applied.
DROP POLICY IF EXISTS reviews_venue_scope_select ON public.reviews;
DROP POLICY IF EXISTS reviews_venue_scope_update ON public.reviews;
DROP POLICY IF EXISTS reviews_super_admin       ON public.reviews;

ALTER TABLE public.reviews ENABLE ROW LEVEL SECURITY;

CREATE POLICY reviews_venue_scope_select ON public.reviews
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

-- UPDATE: operators legitimately edit response_text + is_featured from
-- the /intel/reviews page. Scope the policy to their venue. INSERTs
-- still go through service-role (ingestion services), DELETEs ditto.
CREATE POLICY reviews_venue_scope_update ON public.reviews
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

CREATE POLICY reviews_super_admin ON public.reviews
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON TABLE public.reviews IS
  'Third-party review records (Google / The Knot / WeddingWire / Zola / '
  'Yelp / Facebook). Reads gated by user_profiles.venue_id. Writes only '
  'via service-role (ingestion services + paste API). TIER 7a (2026-05-14).';
