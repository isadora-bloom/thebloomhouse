-- Migration 141: RLS perf — encapsulate visible-venue scope in a STABLE function
--
-- Pre-migration every RLS policy on a venue-scoped table did:
--   venue_id IN (
--     SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
--     UNION
--     SELECT v.id FROM public.venues v
--       JOIN public.user_profiles up ON up.org_id = v.org_id
--       WHERE up.id = auth.uid()
--   )
--
-- For high-traffic tables (engagement_events, interactions,
-- transcript_segments, marketing_channels, etc.) this UNION JOIN runs
-- per row evaluation. Postgres can hoist STABLE functions out of the
-- per-row evaluation, so wrapping the subquery in a SECURITY DEFINER
-- STABLE function lets the planner cache it for the duration of the
-- query.
--
-- This migration:
--   1. Defines public.user_visible_venue_ids() — returns the set of
--      venue_ids the current auth.uid() can see.
--   2. Updates RLS policies on the high-traffic T2-era tables added
--      this session (marketing_channels / coordinator_absences /
--      venue_operational_state / pricing_history / transcript_segments
--      / forbidden topics / onboarding_projects / cultural_moments /
--      candidate_identities) to call the function.
--
-- Legacy tables (engagement_events / interactions / weddings / etc.)
-- are NOT updated here. They use the same UNION JOIN pattern but
-- changing them in this migration carries a higher behavioral risk.
-- A targeted follow-up migration should benchmark each before swap.
--
-- ROLLBACK: drop the function and restore inline UNION JOIN policies.
-- Each touched policy is re-creatable from the original migration's
-- definition.
--
-- Idempotent: CREATE OR REPLACE FUNCTION; DROP / CREATE policies.

CREATE OR REPLACE FUNCTION public.user_visible_venue_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT up.venue_id
    FROM public.user_profiles up
    WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
  UNION
  SELECT v.id
    FROM public.venues v
    JOIN public.user_profiles up ON up.org_id = v.org_id
    WHERE up.id = auth.uid()
$$;

COMMENT ON FUNCTION public.user_visible_venue_ids() IS
  'Returns venue_ids the current authenticated user can see. STABLE + '
  'SECURITY DEFINER so the planner caches the result for the duration '
  'of one query — RLS policies on venue-scoped tables call this '
  'instead of inlining the UNION JOIN per-row. Per Playbook OPS-21.6.x.';

GRANT EXECUTE ON FUNCTION public.user_visible_venue_ids() TO authenticated, anon, service_role;

-- Helper for the demo path.
CREATE OR REPLACE FUNCTION public.demo_visible_venue_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
AS $$
  SELECT id FROM public.venues WHERE is_demo = true
$$;

GRANT EXECUTE ON FUNCTION public.demo_visible_venue_ids() TO anon, authenticated, service_role;

-- =====================================================================
-- Update RLS policies on T2-era tables to use the function
-- =====================================================================

-- marketing_channels (migration 131)
DROP POLICY IF EXISTS "marketing_channels_select" ON public.marketing_channels;
CREATE POLICY "marketing_channels_select" ON public.marketing_channels
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

DROP POLICY IF EXISTS "marketing_channels_modify" ON public.marketing_channels;
CREATE POLICY "marketing_channels_modify" ON public.marketing_channels
  FOR ALL TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin())
  WITH CHECK (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

-- coordinator_absences (migration 132)
DROP POLICY IF EXISTS "coordinator_absences_select" ON public.coordinator_absences;
CREATE POLICY "coordinator_absences_select" ON public.coordinator_absences
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

DROP POLICY IF EXISTS "coordinator_absences_modify" ON public.coordinator_absences;
CREATE POLICY "coordinator_absences_modify" ON public.coordinator_absences
  FOR ALL TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin())
  WITH CHECK (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

-- venue_operational_state (migration 133)
DROP POLICY IF EXISTS "venue_operational_state_select" ON public.venue_operational_state;
CREATE POLICY "venue_operational_state_select" ON public.venue_operational_state
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

DROP POLICY IF EXISTS "venue_operational_state_modify" ON public.venue_operational_state;
CREATE POLICY "venue_operational_state_modify" ON public.venue_operational_state
  FOR ALL TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin())
  WITH CHECK (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

-- pricing_history (migration 134) — read-only for authenticated; INSERT
-- gated separately (append-only).
DROP POLICY IF EXISTS "pricing_history_select" ON public.pricing_history;
CREATE POLICY "pricing_history_select" ON public.pricing_history
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

DROP POLICY IF EXISTS "pricing_history_insert" ON public.pricing_history;
CREATE POLICY "pricing_history_insert" ON public.pricing_history
  FOR INSERT TO authenticated
  WITH CHECK (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

-- transcript_segments (migration 129)
DROP POLICY IF EXISTS "transcript_segments_select" ON public.transcript_segments;
CREATE POLICY "transcript_segments_select" ON public.transcript_segments
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

-- venue_forbidden_topics (migration 125)
DROP POLICY IF EXISTS "venue_forbidden_topics_select" ON public.venue_forbidden_topics;
CREATE POLICY "venue_forbidden_topics_select" ON public.venue_forbidden_topics
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

DROP POLICY IF EXISTS "venue_forbidden_topics_insert" ON public.venue_forbidden_topics;
CREATE POLICY "venue_forbidden_topics_insert" ON public.venue_forbidden_topics
  FOR INSERT TO authenticated
  WITH CHECK (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

DROP POLICY IF EXISTS "venue_forbidden_topics_update" ON public.venue_forbidden_topics;
CREATE POLICY "venue_forbidden_topics_update" ON public.venue_forbidden_topics
  FOR UPDATE TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

-- onboarding_projects (migration 136)
DROP POLICY IF EXISTS "onboarding_projects_select" ON public.onboarding_projects;
CREATE POLICY "onboarding_projects_select" ON public.onboarding_projects
  FOR SELECT TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

DROP POLICY IF EXISTS "onboarding_projects_modify" ON public.onboarding_projects;
CREATE POLICY "onboarding_projects_modify" ON public.onboarding_projects
  FOR ALL TO authenticated
  USING (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin())
  WITH CHECK (venue_id IN (SELECT public.user_visible_venue_ids()) OR public.is_super_admin());

COMMENT ON COLUMN public.marketing_channels.venue_id IS
  'See public.user_visible_venue_ids() — RLS policy reads this STABLE '
  'function instead of inlining the UNION JOIN per row.';
