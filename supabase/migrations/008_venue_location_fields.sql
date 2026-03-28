-- ============================================
-- 008: VENUE LOCATION + INTELLIGENCE FIELDS
-- Adds fields needed by intelligence services
-- (trends metro, NOAA station, briefing email)
-- and expands venue_config for branding.
-- ============================================

-- Location & intelligence identifiers on venues
ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS google_trends_metro text,
  ADD COLUMN IF NOT EXISTS noaa_station_id text,
  ADD COLUMN IF NOT EXISTS briefing_email text,
  ADD COLUMN IF NOT EXISTS address_line1 text,
  ADD COLUMN IF NOT EXISTS city text,
  ADD COLUMN IF NOT EXISTS state text,
  ADD COLUMN IF NOT EXISTS zip text,
  ADD COLUMN IF NOT EXISTS latitude decimal,
  ADD COLUMN IF NOT EXISTS longitude decimal;

-- Add a heading_font_url override (optional, for venues that want a truly custom font)
ALTER TABLE venue_config
  ADD COLUMN IF NOT EXISTS custom_heading_font_url text,
  ADD COLUMN IF NOT EXISTS custom_body_font_url text,
  ADD COLUMN IF NOT EXISTS favicon_url text,
  ADD COLUMN IF NOT EXISTS portal_tagline text;

COMMENT ON COLUMN venues.google_trends_metro IS 'SerpAPI metro code e.g. US-VA-584';
COMMENT ON COLUMN venues.noaa_station_id IS 'NOAA CDO station ID e.g. USW00093738';
COMMENT ON COLUMN venues.briefing_email IS 'Email for weekly intelligence briefings';
COMMENT ON COLUMN venue_config.font_pair IS 'Key from FONT_PAIRS config: playfair_inter, cormorant_lato, etc.';
COMMENT ON COLUMN venue_config.portal_tagline IS 'Tagline shown on couple portal login e.g. Your dream wedding starts here';
