-- ============================================
-- 015: VENDORS + CONTRACTS UPGRADE
-- Adds booked_vendors table for couple vendor tracking,
-- and expands contracts table for AI analysis pipeline.
-- Depends on: 004_portal_tables.sql
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Booked Vendors — couple's own vendor records with contract tracking
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS booked_vendors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  wedding_id uuid NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  vendor_type text NOT NULL,
  vendor_name text,
  vendor_contact text,
  notes text,
  is_booked boolean DEFAULT false,
  contract_uploaded boolean DEFAULT false,
  contract_url text,
  contract_storage_path text,
  contract_date timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
COMMENT ON TABLE booked_vendors IS 'owner:portal';

CREATE INDEX IF NOT EXISTS idx_booked_vendors_venue_id ON booked_vendors(venue_id);
CREATE INDEX IF NOT EXISTS idx_booked_vendors_wedding_id ON booked_vendors(wedding_id);
CREATE INDEX IF NOT EXISTS idx_booked_vendors_type ON booked_vendors(wedding_id, vendor_type);

-- ---------------------------------------------------------------------------
-- 2. Expand contracts table for AI analysis pipeline
-- ---------------------------------------------------------------------------
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS file_url text,
  ADD COLUMN IF NOT EXISTS key_terms text[],
  ADD COLUMN IF NOT EXISTS analysis text,
  ADD COLUMN IF NOT EXISTS analyzed_at timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES booked_vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS vendor_name text,
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'uploaded',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- ---------------------------------------------------------------------------
-- 3. Expand planning_notes category constraint for contract extraction
-- ---------------------------------------------------------------------------
ALTER TABLE planning_notes
  DROP CONSTRAINT IF EXISTS planning_notes_category_check;

ALTER TABLE planning_notes
  ADD CONSTRAINT planning_notes_category_check
  CHECK (category IN ('vendor', 'guest_count', 'decor', 'checklist', 'cost', 'date', 'policy', 'note'));
