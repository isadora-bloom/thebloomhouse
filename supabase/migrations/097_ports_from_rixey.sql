-- ---------------------------------------------------------------------------
-- 097_ports_from_rixey.sql
-- ---------------------------------------------------------------------------
-- Tables for the rixey-portal feature ports identified in the 2026-04-28
-- cross-portal audit:
--
--   day_of_media            — venue uploads photos/videos to the couple
--                             post-wedding (after-the-day memories surface)
--   wedding_internal_notes  — admin-only notepad per wedding (not visible
--                             to the couple)
--   vendor_checklist        — per-vendor task tracking, joined to
--                             booked_vendors
--   zoom_connections        — Zoom OAuth tokens (multi-account per venue)
--   processed_zoom_meetings — dedup log for Zoom meeting transcripts so
--                             cron syncs are idempotent
--   openphone_connections   — OpenPhone API key per venue + phone numbers
--   processed_sms_messages  — dedup log for OpenPhone SMS/voice imports
--
-- All tables follow the existing venue_isolation + super_admin_bypass RLS
-- pattern from migration 006. Wedding-scoped tables carry both venue_id
-- and wedding_id so the venue_isolation policy works without a join.
-- ---------------------------------------------------------------------------

-- day_of_media ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS day_of_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('photo', 'video', 'video_message')),
  url text NOT NULL,
  storage_path text,
  filename text,
  mime_type text,
  size_bytes bigint,
  caption text,
  sort_order integer DEFAULT 0,
  uploaded_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
COMMENT ON TABLE day_of_media IS 'owner:portal — venue uploads photos/videos to couple after the wedding';

CREATE INDEX IF NOT EXISTS idx_day_of_media_wedding ON day_of_media(wedding_id);
CREATE INDEX IF NOT EXISTS idx_day_of_media_venue ON day_of_media(venue_id);
CREATE INDEX IF NOT EXISTS idx_day_of_media_category ON day_of_media(wedding_id, category);

ALTER TABLE day_of_media ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON day_of_media
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON day_of_media
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));


-- wedding_internal_notes -----------------------------------------------------

CREATE TABLE IF NOT EXISTS wedding_internal_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  content text NOT NULL,
  created_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE wedding_internal_notes IS 'owner:portal — admin-only notepad per wedding (never visible to couple)';

CREATE INDEX IF NOT EXISTS idx_internal_notes_wedding ON wedding_internal_notes(wedding_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_internal_notes_venue ON wedding_internal_notes(venue_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON wedding_internal_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE wedding_internal_notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON wedding_internal_notes
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON wedding_internal_notes
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));


-- vendor_checklist -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS vendor_checklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL REFERENCES booked_vendors(id) ON DELETE CASCADE,
  task text NOT NULL,
  is_completed boolean DEFAULT false,
  completed_at timestamptz,
  due_date date,
  notes text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE vendor_checklist IS 'owner:portal — per-vendor task tracking joined to booked_vendors';

CREATE INDEX IF NOT EXISTS idx_vendor_checklist_vendor ON vendor_checklist(vendor_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_vendor_checklist_wedding ON vendor_checklist(wedding_id);
CREATE INDEX IF NOT EXISTS idx_vendor_checklist_venue ON vendor_checklist(venue_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON vendor_checklist
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE vendor_checklist ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON vendor_checklist
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON vendor_checklist
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));


-- zoom_connections -----------------------------------------------------------

CREATE TABLE IF NOT EXISTS zoom_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  zoom_user_id text NOT NULL,
  account_email text,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  expires_at timestamptz NOT NULL,
  scope text,
  is_active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (venue_id, zoom_user_id)
);
COMMENT ON TABLE zoom_connections IS 'owner:agent — Zoom OAuth tokens, multi-account per venue';

CREATE INDEX IF NOT EXISTS idx_zoom_connections_venue ON zoom_connections(venue_id);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON zoom_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE zoom_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON zoom_connections
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON zoom_connections
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));


-- processed_zoom_meetings ----------------------------------------------------

CREATE TABLE IF NOT EXISTS processed_zoom_meetings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  zoom_meeting_id text NOT NULL,
  zoom_meeting_uuid text,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  meeting_topic text,
  meeting_start_time timestamptz,
  duration_minutes integer,
  participant_names text[],
  transcript_text text,
  recording_urls jsonb,
  processed_at timestamptz DEFAULT now(),
  UNIQUE (venue_id, zoom_meeting_id)
);
COMMENT ON TABLE processed_zoom_meetings IS 'owner:agent — dedup log for Zoom meeting transcripts';

CREATE INDEX IF NOT EXISTS idx_proc_zoom_venue ON processed_zoom_meetings(venue_id, processed_at DESC);
CREATE INDEX IF NOT EXISTS idx_proc_zoom_wedding ON processed_zoom_meetings(wedding_id);

ALTER TABLE processed_zoom_meetings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON processed_zoom_meetings
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON processed_zoom_meetings
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));


-- openphone_connections ------------------------------------------------------

CREATE TABLE IF NOT EXISTS openphone_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL UNIQUE REFERENCES venues(id) ON DELETE CASCADE,
  api_key text NOT NULL,
  phone_numbers jsonb DEFAULT '[]'::jsonb,
  workspace_label text,
  is_active boolean DEFAULT true,
  last_synced_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE openphone_connections IS 'owner:agent — OpenPhone API key + phone-number filter per venue';

CREATE TRIGGER set_updated_at BEFORE UPDATE ON openphone_connections
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

ALTER TABLE openphone_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON openphone_connections
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON openphone_connections
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));


-- processed_sms_messages -----------------------------------------------------

CREATE TABLE IF NOT EXISTS processed_sms_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  openphone_message_id text NOT NULL,
  wedding_id uuid REFERENCES weddings(id) ON DELETE SET NULL,
  direction text CHECK (direction IN ('inbound', 'outbound')),
  channel text CHECK (channel IN ('sms', 'voicemail', 'call_summary')) DEFAULT 'sms',
  from_number text,
  to_number text,
  body_text text,
  occurred_at timestamptz,
  processed_at timestamptz DEFAULT now(),
  UNIQUE (venue_id, openphone_message_id)
);
COMMENT ON TABLE processed_sms_messages IS 'owner:agent — dedup log for OpenPhone SMS/voicemail imports';

CREATE INDEX IF NOT EXISTS idx_proc_sms_venue ON processed_sms_messages(venue_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_proc_sms_wedding ON processed_sms_messages(wedding_id);

ALTER TABLE processed_sms_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "venue_isolation" ON processed_sms_messages
  FOR ALL TO authenticated
  USING (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()))
  WITH CHECK (venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid()));

CREATE POLICY "super_admin_bypass" ON processed_sms_messages
  FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE id = auth.uid() AND role = 'super_admin'));


-- Storage bucket for day-of-media uploads ------------------------------------
-- Public-read like the other photo buckets so signed-URL handling stays
-- simple. Authenticated CRUD enforced by table-level RLS on day_of_media.
INSERT INTO storage.buckets (id, name, public)
VALUES ('day-of-media', 'day-of-media', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

DROP POLICY IF EXISTS "day_of_media_authenticated_select" ON storage.objects;
DROP POLICY IF EXISTS "day_of_media_authenticated_insert" ON storage.objects;
DROP POLICY IF EXISTS "day_of_media_authenticated_update" ON storage.objects;
DROP POLICY IF EXISTS "day_of_media_authenticated_delete" ON storage.objects;
DROP POLICY IF EXISTS "day_of_media_anon_select" ON storage.objects;

CREATE POLICY "day_of_media_authenticated_select" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'day-of-media');
CREATE POLICY "day_of_media_authenticated_insert" ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'day-of-media');
CREATE POLICY "day_of_media_authenticated_update" ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'day-of-media')
  WITH CHECK (bucket_id = 'day-of-media');
CREATE POLICY "day_of_media_authenticated_delete" ON storage.objects
  FOR DELETE TO authenticated USING (bucket_id = 'day-of-media');
-- Anon SELECT so the public wedding-website / couple-shared-link path
-- can render thumbnails without needing a signed URL.
CREATE POLICY "day_of_media_anon_select" ON storage.objects
  FOR SELECT TO anon USING (bucket_id = 'day-of-media');


NOTIFY pgrst, 'reload schema';
