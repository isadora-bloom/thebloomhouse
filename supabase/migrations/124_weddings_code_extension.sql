-- Migration 124: weddings.code_extension + booked-graduation trigger (T1-C)
--
-- Per Playbook INV-2.3-B and BUILD-PLAN T1-C: booked extension preserves
-- number lineage (HM-0847 → HM-0847.B). Pre-migration the doctrine cell
-- was at-risk because:
--   - weddings has no parent_wedding_id / extension column
--   - no code path produces .B
--   - booking is a status flip on a single row, not a state-change-visible
--     signal that the rendered number reflects
--
-- This migration:
--   1. Adds weddings.code_extension text NULL
--   2. Adds a BEFORE UPDATE OF status trigger that stamps
--      code_extension='B' when status moves to 'booked' and the column
--      is currently NULL. Idempotent — once set, never recomputed.
--   3. Backfills existing booked rows (status IN ('booked','completed'))
--      so historical data renders consistently.
--
-- Graduation rule per BUILD-PLAN T1-C is "contract_signed AND
-- first_payment_received". The current schema has only the status flip
-- (booked-confirmation writes a contract_signed touchpoint at the same
-- moment). first_payment_received tracking arrives with T2-F (HoneyBook
-- lifecycle events). For now, status='booked' IS the graduation event;
-- when T2-F lands the trigger can be tightened.
--
-- The CHECK on code_extension is open-ended ('B', 'C', etc) for future
-- extensions like "rebooked under same lineage" or "renewal" without
-- requiring a constraint-rewrite migration.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, DROP TRIGGER IF EXISTS, CREATE
-- OR REPLACE on the function.

-- =====================================================================
-- Schema
-- =====================================================================

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS code_extension text;

ALTER TABLE weddings
  DROP CONSTRAINT IF EXISTS weddings_code_extension_check;
ALTER TABLE weddings
  ADD CONSTRAINT weddings_code_extension_check
    CHECK (code_extension IS NULL OR code_extension ~ '^[A-Z]$');

COMMENT ON COLUMN weddings.code_extension IS
  'Per-wedding suffix appended to the Bloom number when the wedding '
  'graduates from prospective to booked (e.g. HM-0847 → HM-0847.B). '
  'NULL until status reaches ''booked''. Stamped by '
  'trg_weddings_set_code_extension on UPDATE OF status. Constraint '
  'permits any single uppercase letter for future graduation kinds. '
  'Per Playbook INV-2.3-B / BUILD-PLAN T1-C.';

-- =====================================================================
-- Trigger
-- =====================================================================

CREATE OR REPLACE FUNCTION set_code_extension_on_booked()
RETURNS TRIGGER AS $$
BEGIN
  -- Only stamp if moving INTO booked from something else, AND extension
  -- is not already set. Idempotent re-flips (booked → booked or
  -- booked → completed → booked) leave the original 'B' alone.
  IF NEW.status IN ('booked', 'completed')
     AND (OLD.status IS NULL OR OLD.status NOT IN ('booked', 'completed'))
     AND NEW.code_extension IS NULL THEN
    NEW.code_extension := 'B';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_weddings_set_code_extension ON weddings;
CREATE TRIGGER trg_weddings_set_code_extension
  BEFORE UPDATE OF status ON weddings
  FOR EACH ROW
  EXECUTE FUNCTION set_code_extension_on_booked();

COMMENT ON FUNCTION set_code_extension_on_booked() IS
  'BEFORE UPDATE OF status: stamps code_extension=''B'' when status '
  'transitions into booked/completed and extension is NULL. Idempotent. '
  'Per Playbook INV-2.3-B.';

-- =====================================================================
-- Backfill historical booked weddings
-- =====================================================================
-- Trigger only fires on UPDATE; rows that were already booked before
-- this migration get a one-shot backfill so the UI renders consistently.

UPDATE weddings
   SET code_extension = 'B'
 WHERE status IN ('booked', 'completed')
   AND code_extension IS NULL;
