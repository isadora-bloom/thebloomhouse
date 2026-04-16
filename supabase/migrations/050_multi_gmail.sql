-- Multi-Gmail connections: each venue can have multiple Gmail accounts
-- linked to specific coordinators.

CREATE TABLE IF NOT EXISTS gmail_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),  -- which coordinator this belongs to
  email_address text NOT NULL,
  gmail_tokens jsonb NOT NULL,
  is_primary boolean DEFAULT false,  -- primary inbox for the venue
  label text,  -- e.g., "Inquiries", "Bookings", "Jordan's email"
  sync_enabled boolean DEFAULT true,
  last_sync_at timestamptz,
  last_history_id text,
  status text DEFAULT 'active' CHECK (status IN ('active', 'error', 'disconnected')),
  error_message text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE(venue_id, email_address)
);

CREATE INDEX idx_gmail_connections_venue ON gmail_connections(venue_id);
CREATE INDEX idx_gmail_connections_user ON gmail_connections(user_id);

-- RLS
ALTER TABLE gmail_connections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all_gmail" ON gmail_connections FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "anon_select_gmail" ON gmail_connections FOR SELECT TO anon USING (true);

-- Track which gmail connection an email came from
ALTER TABLE interactions ADD COLUMN IF NOT EXISTS gmail_connection_id uuid REFERENCES gmail_connections(id);
