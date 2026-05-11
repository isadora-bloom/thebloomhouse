-- ---------------------------------------------------------------------------
-- 295_multichannel_inbox_support.sql  (Wave 29)
-- ---------------------------------------------------------------------------
-- Schema affordances for SMS + Zoom ingestion. The interactions.type CHECK
-- already supports 'sms' (mig 178) and 'meeting' (mig 100) — Zoom transcripts
-- ride on 'meeting'. This migration only adds the operational tables:
--
--   1. twilio_webhook_log — every Twilio webhook hits this table first
--      (idempotency log). Per-venue scoped via phone_number.
--   2. zoom_webhook_log — analogous for Zoom.
--   3. multi_channel_inbox_settings — per-venue config (which channels are
--      enabled, what phone numbers / Zoom accounts to listen to).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS twilio_webhook_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID REFERENCES venues(id) ON DELETE CASCADE,
  message_sid TEXT NOT NULL,
  from_phone TEXT,
  to_phone TEXT,
  body TEXT,
  num_media INTEGER DEFAULT 0,
  raw_payload JSONB,
  interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (message_sid)
);

CREATE INDEX IF NOT EXISTS idx_twilio_webhook_log_venue
  ON twilio_webhook_log (venue_id, created_at DESC);

CREATE TABLE IF NOT EXISTS zoom_webhook_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id UUID REFERENCES venues(id) ON DELETE CASCADE,
  meeting_uuid TEXT NOT NULL,
  event_type TEXT,
  topic TEXT,
  host_email TEXT,
  start_time TIMESTAMPTZ,
  duration_minutes INTEGER,
  recording_url TEXT,
  transcript_url TEXT,
  raw_payload JSONB,
  interaction_id UUID REFERENCES interactions(id) ON DELETE SET NULL,
  processed_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (meeting_uuid, event_type)
);

CREATE INDEX IF NOT EXISTS idx_zoom_webhook_log_venue
  ON zoom_webhook_log (venue_id, start_time DESC);

CREATE TABLE IF NOT EXISTS multi_channel_inbox_settings (
  venue_id UUID PRIMARY KEY REFERENCES venues(id) ON DELETE CASCADE,
  sms_enabled BOOLEAN DEFAULT false,
  twilio_phone_numbers TEXT[] DEFAULT '{}',
  zoom_enabled BOOLEAN DEFAULT false,
  zoom_account_emails TEXT[] DEFAULT '{}',
  voice_capture_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: scope reads to the venue's own settings.
ALTER TABLE twilio_webhook_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoom_webhook_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE multi_channel_inbox_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS twilio_webhook_log_venue_read ON twilio_webhook_log;
CREATE POLICY twilio_webhook_log_venue_read ON twilio_webhook_log
  FOR SELECT USING (
    venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid())
  );

DROP POLICY IF EXISTS zoom_webhook_log_venue_read ON zoom_webhook_log;
CREATE POLICY zoom_webhook_log_venue_read ON zoom_webhook_log
  FOR SELECT USING (
    venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid())
  );

DROP POLICY IF EXISTS mci_settings_venue_rw ON multi_channel_inbox_settings;
CREATE POLICY mci_settings_venue_rw ON multi_channel_inbox_settings
  FOR ALL USING (
    venue_id = (SELECT venue_id FROM user_profiles WHERE id = auth.uid())
  );

NOTIFY pgrst, 'reload schema';
