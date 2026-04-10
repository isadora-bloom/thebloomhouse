-- ============================================
-- 034: CONTRACTED PIPELINE STAGE
-- Adds 'contracted' status between 'proposal_sent' and 'booked'.
-- Auto-moves weddings to 'contracted' when a contract is signed.
-- ============================================

-- ---------------------------------------------------------------------------
-- 1. Drop and recreate the status check constraint to include 'contracted'
-- ---------------------------------------------------------------------------
ALTER TABLE weddings DROP CONSTRAINT IF EXISTS weddings_status_check;
ALTER TABLE weddings ADD CONSTRAINT weddings_status_check
  CHECK (status IN ('inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent', 'contracted', 'booked', 'completed', 'lost', 'cancelled'));

-- ---------------------------------------------------------------------------
-- 2. Ensure contracted_at column exists (idempotent)
-- ---------------------------------------------------------------------------
ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS contracted_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. Trigger: when contracts.status is updated to 'signed',
--    auto-move the wedding to 'contracted' (and log activity).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_move_to_contracted_on_signed()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'signed' AND (OLD.status IS NULL OR OLD.status != 'signed') THEN
    UPDATE weddings
    SET status = 'contracted', contracted_at = NOW()
    WHERE id = NEW.wedding_id
      AND status IN ('inquiry', 'tour_scheduled', 'tour_completed', 'proposal_sent');

    -- Log to activity_log (best-effort)
    INSERT INTO activity_log (id, venue_id, wedding_id, activity_type, entity_type, entity_id, details, created_at)
    SELECT
      gen_random_uuid(), w.venue_id, w.id, 'pipeline_change', 'wedding', w.id,
      jsonb_build_object('from', 'proposal_sent', 'to', 'contracted', 'reason', 'contract_signed'),
      NOW()
    FROM weddings w WHERE w.id = NEW.wedding_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contract_signed_pipeline ON contracts;
CREATE TRIGGER trg_contract_signed_pipeline
  AFTER INSERT OR UPDATE ON contracts
  FOR EACH ROW
  EXECUTE FUNCTION auto_move_to_contracted_on_signed();

-- ---------------------------------------------------------------------------
-- 4. Seed: mark 2 demo weddings as contracted for pipeline visibility.
--    Targets Claire & Tom Henderson at Hawthorne Manor and
--    Ava & Ethan Cole at The Glass House.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_claire_id uuid;
  v_ava_id uuid;
BEGIN
  SELECT w.id INTO v_claire_id
  FROM weddings w
  WHERE w.venue_id = '22222222-2222-2222-2222-222222222201'
    AND EXISTS (SELECT 1 FROM people p WHERE p.wedding_id = w.id AND p.first_name = 'Claire')
  LIMIT 1;

  IF v_claire_id IS NOT NULL THEN
    UPDATE weddings SET status = 'contracted', contracted_at = '2025-12-15 10:00:00' WHERE id = v_claire_id;
  END IF;

  SELECT w.id INTO v_ava_id
  FROM weddings w
  WHERE w.venue_id = '22222222-2222-2222-2222-222222222203'
    AND EXISTS (SELECT 1 FROM people p WHERE p.wedding_id = w.id AND p.first_name = 'Ava')
  LIMIT 1;

  IF v_ava_id IS NOT NULL THEN
    UPDATE weddings SET status = 'contracted', contracted_at = '2026-01-20 14:00:00' WHERE id = v_ava_id;
  END IF;
END $$;
