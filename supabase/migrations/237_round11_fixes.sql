-- ============================================================================
-- 237_round11_fixes.sql
-- Round 11 audit fixes (2026-05-08).
--
-- Two RLS gaps:
--
-- (P1) cron_runs + metered_events SELECT policies filter to the user's
-- venue/org. Super-admins were intended to see platform-wide telemetry
-- on /super-admin/observability, but the policies as shipped silently
-- truncated their view to their own venue's crons. Add the missing
-- is_super_admin() bypass.
--
-- (P0) pricing_history is append-only by mig 142 doctrine — no UPDATE
-- policy for authenticated, by design. /intel/pricing-history's
-- saveNote was attempting a browser-client UPDATE and getting denied.
-- The fix is *not* to relax the append-only doctrine; it's to route
-- note writes through a service-role API endpoint. This migration
-- only covers the observability fix; the API route lives in app code.
-- ============================================================================

-- cron_runs: super_admin bypass for platform-wide visibility.
DROP POLICY IF EXISTS "cron_runs_select" ON public.cron_runs;
CREATE POLICY "cron_runs_select" ON public.cron_runs
  FOR SELECT TO authenticated
  USING (
    venue_id IS NULL
    OR venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid() AND up.role IN ('org_admin', 'super_admin')
    )
    OR public.is_super_admin()
  );

-- metered_events: same fix.
DROP POLICY IF EXISTS "metered_events_select" ON public.metered_events;
CREATE POLICY "metered_events_select" ON public.metered_events
  FOR SELECT TO authenticated
  USING (
    venue_id IS NULL
    OR venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid() AND up.role IN ('org_admin', 'super_admin')
    )
    OR public.is_super_admin()
  );
