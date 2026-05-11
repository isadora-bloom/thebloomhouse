-- ---------------------------------------------------------------------------
-- 294_interactions_surface.sql  (Wave 28)
-- ---------------------------------------------------------------------------
-- Adds the fourth dimension to interactions: WHERE this signal should appear.
--
-- The /agent/inbox surface today shows every type='email' direction='inbound'
-- row. That includes:
--   - HoneyBook synthetic interactions (source_provenance attribution from
--     CRM import) → should appear on lead-detail timeline, NOT in inbox
--   - Calendly tour-confirmation emails ("Sarah Smith booked a tour") →
--     should appear on lead-detail timeline, NOT in inbox
--   - Knot/WeddingWire/Zola lead-relay alerts → could go either way; for
--     now we leave them in inbox since the operator may want to triage
--
-- surface values:
--   inbox                — couple-facing conversation thread (DEFAULT)
--   system_notification  — automated email from a SaaS tool (Calendly,
--                          HoneyBook, autoresponder)
--   crm_attribution      — synthetic interaction from a CRM import adapter
--                          (HoneyBook, Dubsado, Aisle Planner sync rows)
--   voice_capture        — Omi/Plaud/SMS transcript appears in /agent/audio-inbox
--   integration_event    — webhook-driven structured event (Calendly booking,
--                          Twilio SMS receipt, Zoom transcript) where the
--                          ROW IS the event, not the email about it
--
-- Default 'inbox' preserves existing UI behavior for every row that doesn't
-- match a rule. Pipeline write site + CRM adapters set surface explicitly
-- for known cases.
-- ---------------------------------------------------------------------------

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS surface TEXT NOT NULL DEFAULT 'inbox';

ALTER TABLE interactions DROP CONSTRAINT IF EXISTS interactions_surface_check;
ALTER TABLE interactions
  ADD CONSTRAINT interactions_surface_check
  CHECK (surface IN ('inbox', 'system_notification', 'crm_attribution', 'voice_capture', 'integration_event'));

-- ---------------------------------------------------------------------------
-- Backfill rules (rules-based, no AI call — these are structural).
-- ---------------------------------------------------------------------------

-- CRM import rows: every interaction with a non-null crm_source flag that
-- was written by an import adapter (vs by the email pipeline) is
-- crm_attribution. The synthetic source-attribution rows that HoneyBook
-- writes (body starts with "provider:honeybook") are the canonical case.
UPDATE interactions
SET surface = 'crm_attribution'
WHERE surface = 'inbox'
  AND crm_source IS NOT NULL
  AND (
    full_body LIKE 'provider:%'
    OR subject IS NULL
  );

-- Calendly system emails — direction=inbound, type=email, from-domain matches
-- Calendly's sending addresses. The actual tour booking is captured as a
-- separate engagement_events row + tours row by the Calendly webhook; the
-- email is duplicate UI clutter.
UPDATE interactions
SET surface = 'system_notification'
WHERE surface = 'inbox'
  AND type = 'email'
  AND direction = 'inbound'
  AND (
    from_email ILIKE '%@calendly.com'
    OR from_email ILIKE '%@acuityscheduling.com'
    OR from_email ILIKE 'notifications@honeybook.com'
    OR from_email ILIKE 'no-reply@%'
    OR from_email ILIKE 'noreply@%'
    OR from_email ILIKE 'donotreply@%'
  );

-- Voice capture: Omi/Plaud transcripts already write type='meeting' with
-- a specific source_context. Stream 3 will land Twilio SMS + Zoom; this
-- migration just claims the surface for existing audio rows.
UPDATE interactions
SET surface = 'voice_capture'
WHERE surface = 'inbox'
  AND type IN ('voicemail', 'meeting')
  AND (
    crm_source IS NULL
    OR crm_source NOT IN ('honeybook', 'dubsado', 'aisle_planner', 'generic_csv')
  );

-- Index used by the inbox query (the main consumer of this column).
CREATE INDEX IF NOT EXISTS idx_interactions_surface_inbox
  ON interactions (venue_id, surface, direction, timestamp DESC)
  WHERE surface = 'inbox';

COMMENT ON COLUMN interactions.surface IS
  'Wave 28: where this signal should appear in the UI. Defaults to inbox; pipeline + CRM adapters route system_notification / crm_attribution / voice_capture / integration_event explicitly.';

NOTIFY pgrst, 'reload schema';
