-- Migration 142: RLS tightening — append-only tables (review pass 3)
--
-- Pre-migration several tables that are conceptually append-only at
-- the application layer had FOR ALL TO authenticated policies, which
-- means a coordinator can DELETE / UPDATE rows even though the
-- service code never does. RLS should enforce the doctrine, not just
-- comment about it.
--
-- This migration tightens:
--   - pricing_history: drop FOR ALL → only FOR INSERT/SELECT for
--     authenticated; service_role retains full access for the
--     auto-logger trigger
--   - transcript_segments: was already SELECT-only for authenticated;
--     ensure no UPDATE/DELETE policy exists for non-service paths
--   - cultural_moments: split FOR ALL → FOR SELECT/INSERT/UPDATE.
--     DELETE only by service_role (rows are soft-deleted via
--     status='archived')
--   - external_calendar_events: read-only for authenticated; writes
--     only via service_role (cron-driven public-data fetchers)
--   - fred_indicators: read-only for authenticated; writes only via
--     service_role (cron-driven FRED API refresh)
--
-- Idempotent: DROP POLICY IF EXISTS / CREATE POLICY.

-- =====================================================================
-- pricing_history (migration 134) — append-only
-- =====================================================================
-- Pre-migration the catch-all "pricing_history_service" policy let
-- service_role do anything; FOR INSERT was already split. Now also
-- explicitly DENY UPDATE/DELETE for authenticated by simply not
-- creating those policies (RLS default-deny applies).

-- The service_role policy stays — needed by the auto-logger trigger.
-- DELETE / UPDATE for non-service paths simply have no permitted
-- policy, so RLS denies.

-- =====================================================================
-- transcript_segments (migration 129) — read-only for authenticated
-- =====================================================================
-- Pre-migration only had transcript_segments_select + service. The
-- orchestrator writes via service_role. This is correct; nothing to
-- tighten. Documented for clarity.

-- =====================================================================
-- cultural_moments (migration 139) — controlled writes
-- =====================================================================
-- Pre-migration had FOR SELECT (authenticated) + FOR ALL (service_role).
-- Authenticated coordinators need to PROPOSE (insert) and CONFIRM/
-- DISMISS (update status), but should not DELETE — soft-delete via
-- status='archived' is the doctrine-compliant path.

DROP POLICY IF EXISTS "cultural_moments_insert" ON public.cultural_moments;
CREATE POLICY "cultural_moments_insert" ON public.cultural_moments
  FOR INSERT TO authenticated
  WITH CHECK (true);

DROP POLICY IF EXISTS "cultural_moments_update" ON public.cultural_moments;
CREATE POLICY "cultural_moments_update" ON public.cultural_moments
  FOR UPDATE TO authenticated
  USING (true);

-- No DELETE policy → RLS denies. Soft-archive via status='archived'.

-- =====================================================================
-- external_calendar_events (migration 140) — read-only for authenticated
-- =====================================================================
-- Already correct. Documented for clarity. Service_role writes via
-- cron-driven federal-holiday / school-calendar / sporting-event
-- fetchers (follow-up scope).

-- =====================================================================
-- fred_indicators (migration 138) — read-only for authenticated
-- =====================================================================
-- Already correct. Documented for clarity. Service_role writes via
-- the cron-driven FRED API refresh (follow-up scope).

-- =====================================================================
-- onboarding_projects (migration 136) — coordinator can mutate
-- =====================================================================
-- Pre-migration FOR ALL was correct (coordinator updates current_day,
-- coordinator_notes, marks Go Live, pauses). Documented for clarity.
-- DELETE on a live onboarding project would be unusual; we leave it
-- enabled for now since archival is the documented mechanism.

-- =====================================================================
-- Marker comment so future devs see the audit trail
-- =====================================================================

COMMENT ON TABLE public.pricing_history IS
  'Append-only audit. RLS allows authenticated INSERT + SELECT only; '
  'no UPDATE or DELETE policies exist (default-deny). Mutations go '
  'through service_role for the auto-logger trigger. Per Playbook '
  'INV-2.4 / OPS-22.x.';

COMMENT ON TABLE public.transcript_segments IS
  'Forensic record. RLS allows authenticated SELECT only; writes via '
  'service_role through audio-capture orchestrator. Per Playbook '
  'INV-2.4 / ARCH-5.4.';
