-- ============================================================================
-- 221: VENUE LOGISTICS FIELDS
--
-- Adds the four columns that the couple-portal /venue-info page already
-- accommodates as optional render blocks (mig 008 added the address; this
-- adds the rest of the day-of logistics surface). Tier-B audit #52
-- ("Walkthrough/parking/where-to-enter logistics").
--
-- Once populated, the existing /couple/[slug]/venue-info page renders:
--   - Parking section (parking_instructions, multi-line text)
--   - Where to enter section (entry_instructions, multi-line text)
--   - Day-of contact card (name + tap-to-call phone)
--
-- All four columns nullable so existing venues aren't disrupted; new venues
-- prompted to populate during onboarding (separate follow-up; this migration
-- is schema-only).
-- ============================================================================

ALTER TABLE venues
  ADD COLUMN IF NOT EXISTS parking_instructions text,
  ADD COLUMN IF NOT EXISTS entry_instructions text,
  ADD COLUMN IF NOT EXISTS day_of_contact_name text,
  ADD COLUMN IF NOT EXISTS day_of_contact_phone text;

COMMENT ON COLUMN venues.parking_instructions IS 'Multi-line plain text. Free-form parking guidance for guests/couples (lot location, valet, overflow). Surfaced on couple portal /venue-info.';
COMMENT ON COLUMN venues.entry_instructions IS 'Multi-line plain text. Where to enter on the day (which gate, accessible entrance, vendor entrance). Surfaced on couple portal /venue-info.';
COMMENT ON COLUMN venues.day_of_contact_name IS 'Name of the day-of coordinator point-of-contact for this venue (e.g. "Sarah from Bloom House"). Distinct from any individual coordinator user account; this is the published name couples and vendors should ask for on arrival.';
COMMENT ON COLUMN venues.day_of_contact_phone IS 'Phone number couples and vendors should call on the day. tel: link rendered on the couple-portal venue-info card.';
