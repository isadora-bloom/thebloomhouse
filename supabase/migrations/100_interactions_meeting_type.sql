-- ---------------------------------------------------------------------------
-- 100_interactions_meeting_type.sql
-- ---------------------------------------------------------------------------
-- Extends the interactions.type CHECK constraint to include 'meeting' so
-- Zoom/transcript ingest can surface meetings alongside email/call/sms in
-- the wedding interaction timeline.
--
-- The Zoom service writes one row per processed Zoom meeting:
--   - type = 'meeting'
--   - direction = 'inbound'
--   - subject = meeting topic
--   - body_preview = first ~500 chars of cleaned transcript
--   - full_body = cleaned VTT text (joined spoken lines)
--   - timestamp = meeting start_time
-- ---------------------------------------------------------------------------

ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_type_check;
ALTER TABLE interactions
  ADD CONSTRAINT interactions_type_check
  CHECK (type IN ('email', 'call', 'voicemail', 'sms', 'meeting'));

NOTIFY pgrst, 'reload schema';
