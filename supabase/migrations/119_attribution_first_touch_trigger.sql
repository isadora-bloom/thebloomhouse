-- Migration 119: Extend bucket recompute trigger to also recompute
-- attribution_events.is_first_touch atomically when inquiry_date moves.
--
-- Self-review of migration 118 caught a half-automation: the trigger
-- recomputed bucket but NOT is_first_touch. So a code path that
-- updated weddings.inquiry_date had to ALSO call
-- candidate-resolver.recomputeFirstTouch explicitly — relying on
-- caller discipline, exactly the bandaid pattern Playbook 14 #16
-- forbids ("Derived fields not recomputed when their inputs change").
--
-- This migration extends the existing recompute_attribution_buckets()
-- function to do both. Renamed for accuracy. The is_first_touch logic
-- mirrors candidate-resolver.recomputeFirstTouch (TypeScript) so the
-- DB-side recompute matches the service-side INSERT path:
--
--   1. After bucket recompute, find rows where bucket='attribution'
--      and reverted_at IS NULL.
--   2. Among those, the row with the EARLIEST tangential_signals.signal_date
--      gets is_first_touch=true. All others false.
--   3. If no attribution rows exist (all are nurture or no signal_date),
--      no row gets is_first_touch=true (consistent with current TS).

CREATE OR REPLACE FUNCTION recompute_attribution_state() RETURNS TRIGGER AS $$
DECLARE
  earliest_event_id uuid;
BEGIN
  -- Only react when inquiry_date actually changed.
  IF OLD.inquiry_date IS DISTINCT FROM NEW.inquiry_date THEN
    -- Step 1: Recompute bucket for every live attribution_event on
    -- this wedding. Same logic as candidate-resolver.ts:550 INSERT-time.
    UPDATE attribution_events ae
    SET bucket = CASE
      WHEN ts.signal_date IS NOT NULL
        AND NEW.inquiry_date IS NOT NULL
        AND ts.signal_date >= NEW.inquiry_date THEN 'nurture'
      ELSE 'attribution'
    END
    FROM tangential_signals ts
    WHERE ae.signal_id = ts.id
      AND ae.wedding_id = NEW.id
      AND ae.reverted_at IS NULL;

    -- Step 2: Recompute is_first_touch. Find the attribution_event
    -- whose joined tangential_signals.signal_date is earliest among
    -- the wedding's live attribution rows. That row is is_first_touch=true;
    -- all others false.
    SELECT ae.id INTO earliest_event_id
    FROM attribution_events ae
    JOIN tangential_signals ts ON ts.id = ae.signal_id
    WHERE ae.wedding_id = NEW.id
      AND ae.reverted_at IS NULL
      AND ae.bucket = 'attribution'
      AND ts.signal_date IS NOT NULL
    ORDER BY ts.signal_date ASC
    LIMIT 1;

    -- Single UPDATE: set is_first_touch=true on the earliest row,
    -- false on all others. CASE WHEN handles the NULL earliest case
    -- (no attribution rows or no signal_dates) by setting all to false.
    UPDATE attribution_events
    SET is_first_touch = (id = earliest_event_id)
    WHERE wedding_id = NEW.id
      AND reverted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Replace the migration-118 trigger with one that calls the renamed
-- function. DROP IF EXISTS so re-running the migration is idempotent.
DROP TRIGGER IF EXISTS weddings_inquiry_date_recompute_buckets ON weddings;
DROP TRIGGER IF EXISTS weddings_inquiry_date_recompute_state ON weddings;

CREATE TRIGGER weddings_inquiry_date_recompute_state
  AFTER UPDATE OF inquiry_date ON weddings
  FOR EACH ROW
  EXECUTE FUNCTION recompute_attribution_state();

-- Drop the migration-118 function — fully superseded by recompute_attribution_state().
DROP FUNCTION IF EXISTS recompute_attribution_buckets();

COMMENT ON FUNCTION recompute_attribution_state() IS
  'Recompute attribution_events.bucket AND is_first_touch atomically '
  'when weddings.inquiry_date moves. Mirrors candidate-resolver TypeScript '
  'logic so DB-side recompute matches service-side INSERT path. Per '
  'Playbook INV-2.5 / Part 12.3: derived fields must update when their '
  'inputs change. Migration 118 only handled bucket; this extends.';
