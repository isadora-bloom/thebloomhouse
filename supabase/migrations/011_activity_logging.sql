-- ============================================
-- 011: ACTIVITY LOGGING & ADMIN NOTIFICATIONS
-- Tracks couple actions and surfaces admin alerts
-- Depends on: 001_shared_tables.sql, 004_portal_tables.sql
-- ============================================

-- Activity Log
CREATE TABLE IF NOT EXISTS activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  user_id uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  activity_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  details jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_log_venue_id ON activity_log(venue_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_wedding_id ON activity_log(wedding_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_at ON activity_log(venue_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_type ON activity_log(venue_id, activity_type);

-- Admin Notifications
CREATE TABLE IF NOT EXISTS admin_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  read boolean DEFAULT false,
  read_at timestamptz,
  email_sent boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_notifications_venue_id ON admin_notifications(venue_id);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_read ON admin_notifications(venue_id, read);
CREATE INDEX IF NOT EXISTS idx_admin_notifications_created_at ON admin_notifications(venue_id, created_at);
