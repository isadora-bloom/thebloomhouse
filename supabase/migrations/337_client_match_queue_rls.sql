-- ---------------------------------------------------------------------------
-- 337_client_match_queue_rls.sql
-- ---------------------------------------------------------------------------
-- Fix: /intel/matching loads with "Failed to load match queue" because
-- client_match_queue had RLS ENABLED by migration 216_seal_rls_post_147_gaps
-- but NO SELECT policy ever created. Default-deny on a table the page
-- queries every render.
--
-- Mirror pattern: candidate_identities + attribution_events use a
-- user_profiles join — same pattern here. Plus a super_admin bypass
-- so the admin console can see all venues.
--
-- This migration touches one table. No data changes.
-- ---------------------------------------------------------------------------

-- Idempotent — drop policies first in case a partial earlier attempt landed.
DROP POLICY IF EXISTS venue_scope_select ON public.client_match_queue;
DROP POLICY IF EXISTS venue_scope_insert ON public.client_match_queue;
DROP POLICY IF EXISTS venue_scope_update ON public.client_match_queue;
DROP POLICY IF EXISTS venue_scope_delete ON public.client_match_queue;
DROP POLICY IF EXISTS super_admin_all ON public.client_match_queue;

-- Venue-scoped SELECT via user_profiles.venue_id (the same pattern
-- used by candidate_identities, attribution_events, and every other
-- intel table). authenticated role only.
CREATE POLICY venue_scope_select ON public.client_match_queue
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

-- Operators can mark items as merged / dismissed from the matching
-- review queue. UPDATE policy with the same venue scope.
CREATE POLICY venue_scope_update ON public.client_match_queue
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

-- INSERT — writers are the candidate-resolver / clusterer which run
-- as service-role and bypass RLS. But authenticated operators can
-- also enqueue manual reviews from the candidate detail UI, so
-- expose a venue-scoped INSERT policy.
CREATE POLICY venue_scope_insert ON public.client_match_queue
  FOR INSERT TO authenticated
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

-- Super-admin bypass — cross-venue access for Bloom internal ops.
-- Uses the existing is_super_admin() helper from mig 304.
CREATE POLICY super_admin_all ON public.client_match_queue
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());
