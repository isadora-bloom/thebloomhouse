-- ============================================================================
-- Migration 032: Client codes backfill + auto-generation trigger
-- ============================================================================
-- 1. Adds venue_prefix to venue_config (e.g., HM, CF, GH, RH)
-- 2. Enforces uniqueness of (venue_id, code) on client_codes
-- 3. Backfills client codes for every wedding that doesn't already have one
-- 4. Installs a trigger that auto-generates codes on new wedding inserts
-- ============================================================================

-- ---- 1. venue_prefix column ----------------------------------------------
ALTER TABLE venue_config ADD COLUMN IF NOT EXISTS venue_prefix text;

UPDATE venue_config SET venue_prefix = 'HM' WHERE venue_id = '22222222-2222-2222-2222-222222222201';
UPDATE venue_config SET venue_prefix = 'CF' WHERE venue_id = '22222222-2222-2222-2222-222222222202';
UPDATE venue_config SET venue_prefix = 'GH' WHERE venue_id = '22222222-2222-2222-2222-222222222203';
UPDATE venue_config SET venue_prefix = 'RH' WHERE venue_id = '22222222-2222-2222-2222-222222222204';

-- ---- 2. Unique index on (venue_id, code) ---------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_codes_venue_code
  ON client_codes(venue_id, code);

-- ---- 3. Backfill ----------------------------------------------------------
WITH numbered AS (
  SELECT
    w.id AS wedding_id,
    w.venue_id,
    vc.venue_prefix,
    ROW_NUMBER() OVER (PARTITION BY w.venue_id ORDER BY w.created_at) AS seq
  FROM weddings w
  JOIN venue_config vc ON vc.venue_id = w.venue_id
  WHERE NOT EXISTS (SELECT 1 FROM client_codes WHERE wedding_id = w.id)
)
INSERT INTO client_codes (id, venue_id, wedding_id, code, created_at)
SELECT
  gen_random_uuid(),
  venue_id,
  wedding_id,
  venue_prefix || '-' || LPAD(seq::text, 4, '0'),
  NOW()
FROM numbered
WHERE venue_prefix IS NOT NULL;

-- ---- 4. Auto-generate trigger --------------------------------------------
CREATE OR REPLACE FUNCTION auto_generate_client_code()
RETURNS TRIGGER AS $$
DECLARE
  v_prefix text;
  v_next_seq int;
  v_code text;
BEGIN
  -- Get venue prefix
  SELECT venue_prefix INTO v_prefix
  FROM venue_config
  WHERE venue_id = NEW.venue_id;

  IF v_prefix IS NULL THEN
    RETURN NEW;  -- No prefix configured, skip code generation
  END IF;

  -- Get next sequential number for this venue
  SELECT COALESCE(MAX(SUBSTRING(code FROM '[0-9]+$')::int), 0) + 1
    INTO v_next_seq
  FROM client_codes
  WHERE venue_id = NEW.venue_id;

  v_code := v_prefix || '-' || LPAD(v_next_seq::text, 4, '0');

  INSERT INTO client_codes (id, venue_id, wedding_id, code, created_at)
  VALUES (gen_random_uuid(), NEW.venue_id, NEW.id, v_code, NOW());

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_auto_client_code ON weddings;
CREATE TRIGGER trg_auto_client_code
  AFTER INSERT ON weddings
  FOR EACH ROW
  EXECUTE FUNCTION auto_generate_client_code();
