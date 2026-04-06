-- ============================================
-- 022: VENUE GROUPS
-- Move venue groups from hardcoded to database.
-- Supports multi-venue portfolio management.
-- ============================================

CREATE TABLE IF NOT EXISTS venue_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE venue_groups IS 'owner:shared';

CREATE TABLE IF NOT EXISTS venue_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES venue_groups(id) ON DELETE CASCADE,
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  UNIQUE(group_id, venue_id)
);
COMMENT ON TABLE venue_group_members IS 'owner:shared';

CREATE INDEX IF NOT EXISTS idx_venue_groups_org ON venue_groups(org_id);
CREATE INDEX IF NOT EXISTS idx_venue_group_members_group ON venue_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_venue_group_members_venue ON venue_group_members(venue_id);
