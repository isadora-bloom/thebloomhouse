-- ---------------------------------------------------------------------------
-- 296_api_costs_rls_hardening.sql  (Tactical: F19)
-- ---------------------------------------------------------------------------
-- The /agent/classification-health page reads api_costs to compute the
-- Sage-cost panel. Today the table may be readable by any authenticated
-- user. F19 flags that non-admin operators see AI cost data they shouldn't.
--
-- Scope: SELECT restricted to super_admin OR venue_owner. Non-admin
-- coordinators see classification health (counts only) but not the cost.
-- ---------------------------------------------------------------------------

ALTER TABLE api_costs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS api_costs_admin_read ON api_costs;
CREATE POLICY api_costs_admin_read ON api_costs
  FOR SELECT USING (
    -- Super-admin (Bloom platform staff) sees everything across venues.
    EXISTS (
      SELECT 1 FROM user_profiles
      WHERE user_profiles.id = auth.uid()
        AND user_profiles.role = 'super_admin'
    )
    OR
    -- Admin-tier roles on the matching venue see their own venue's costs.
    -- user_profiles.role enum per 001_shared_tables: ('super_admin',
    -- 'org_admin', 'venue_manager', 'coordinator', 'couple'). The first
    -- three are the admin tier; coordinator is excluded so reception-style
    -- users don't see $ amounts.
    venue_id = (
      SELECT venue_id FROM user_profiles
      WHERE id = auth.uid()
        AND role IN ('super_admin', 'org_admin', 'venue_manager')
    )
  );

-- INSERT/UPDATE policies remain service-role only — api_costs is
-- written by the cost-tracker (lib/ai/cost-tracker.ts), never by
-- client UI.
DROP POLICY IF EXISTS api_costs_service_write ON api_costs;
CREATE POLICY api_costs_service_write ON api_costs
  FOR INSERT
  WITH CHECK (
    auth.role() = 'service_role'
  );

COMMENT ON POLICY api_costs_admin_read ON api_costs IS
  'F19: AI cost data restricted to super_admin or venue owner/admin. Coordinator role does not see $ figures on /agent/classification-health.';

NOTIFY pgrst, 'reload schema';
