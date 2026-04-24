-- ============================================
-- 090: venue_config.automation_emails
--
-- Venues often have automation senders that aren't in gmail_connections
-- or venue_ai_config but still belong to them — pricing calculators
-- (e.g. contact@interactivecalculator.com), form relays the venue owns,
-- internal tool accounts. Without tracking these the pipeline creates
-- ghost "lead" weddings for them.
--
-- venueOwnEmails() now reads this column so the self-loop guard
-- catches them. Form-relay parsers already handle the common public
-- platforms — this is for venue-specific automation senders.
-- ============================================

ALTER TABLE venue_config
  ADD COLUMN IF NOT EXISTS automation_emails text[] NOT NULL DEFAULT '{}';
