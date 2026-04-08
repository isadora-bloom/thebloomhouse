-- ============================================
-- 026: FIX VENUE GROUPS RLS
-- Tables created in 022 but missing RLS policies.
-- Adds policies for authenticated users (org-based)
-- and anon users (demo mode).
-- ============================================

-- ============================================
-- venue_groups
-- ============================================

ALTER TABLE venue_groups ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read venue groups belonging to their org
CREATE POLICY "venue_isolation" ON venue_groups
  FOR SELECT
  USING (
    org_id IN (
      SELECT v.org_id FROM venues v
      JOIN user_profiles up ON up.venue_id = v.id
      WHERE up.id = auth.uid()
    )
  );

-- Super admins can do everything
CREATE POLICY "super_admin_bypass" ON venue_groups
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- Anon users can read all venue groups (demo mode uses anon key)
CREATE POLICY "anon_read" ON venue_groups
  FOR SELECT
  TO anon
  USING (true);

-- ============================================
-- venue_group_members
-- ============================================

ALTER TABLE venue_group_members ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read group members for groups in their org
CREATE POLICY "venue_isolation" ON venue_group_members
  FOR SELECT
  USING (
    group_id IN (
      SELECT vg.id FROM venue_groups vg
      JOIN venues v ON v.org_id = vg.org_id
      JOIN user_profiles up ON up.venue_id = v.id
      WHERE up.id = auth.uid()
    )
  );

-- Super admins can do everything
CREATE POLICY "super_admin_bypass" ON venue_group_members
  FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));

-- Anon users can read all group members (demo mode uses anon key)
CREATE POLICY "anon_read" ON venue_group_members
  FOR SELECT
  TO anon
  USING (true);
