-- ============================================================================
-- Migration 047: Event codes for couple self-registration
-- ============================================================================
-- Adds event_code to weddings so coordinators can invite couples
-- to self-register on the portal via a unique code link.
-- ============================================================================

-- Event codes for couple self-registration
ALTER TABLE weddings ADD COLUMN IF NOT EXISTS event_code text UNIQUE;
ALTER TABLE weddings ADD COLUMN IF NOT EXISTS couple_invited_at timestamptz;
ALTER TABLE weddings ADD COLUMN IF NOT EXISTS couple_registered_at timestamptz;

-- Index for code lookup
CREATE INDEX IF NOT EXISTS idx_weddings_event_code ON weddings(event_code) WHERE event_code IS NOT NULL;
