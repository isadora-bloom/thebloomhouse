-- Migration 120: Fix NULL-handling bug in recompute_attribution_state()
--
-- Self-spot-check (2026-05-01) caught this in migration 119:
--
--   UPDATE attribution_events
--   SET is_first_touch = (id = earliest_event_id)
--   WHERE wedding_id = NEW.id ...
--
-- When earliest_event_id IS NULL (wedding has no live attribution
-- rows, or none of them have a signal_date), the expression
-- `id = earliest_event_id` evaluates to NULL — but
-- attribution_events.is_first_touch is `NOT NULL` (per migration
-- 105:288). The trigger throws a NOT NULL constraint violation,
-- and the UPDATE OF inquiry_date fails. Latent until a
-- coordinator corrects an inquiry_date on a wedding with no
-- attribution events yet.
--
-- Fix: COALESCE((id = earliest_event_id), false). When
-- earliest_event_id IS NULL, every row gets is_first_touch=false,
-- which matches the no-first-touch case in the TypeScript
-- recomputeFirstTouch (line 466-475 in candidate-resolver.ts) —
-- if there's no earliest, no row is the first touch.
--
-- Idempotent: CREATE OR REPLACE on the function. Trigger doesn't
-- need recreation (it points to the function).

CREATE OR REPLACE FUNCTION recompute_attribution_state() RETURNS TRIGGER AS $$
DECLARE
  earliest_event_id uuid;
BEGIN
  IF OLD.inquiry_date IS DISTINCT FROM NEW.inquiry_date THEN
    -- Step 1: Recompute bucket. Same logic as 119.
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

    -- Step 2: Find the earliest attribution event. NULL when no
    -- attribution rows exist or none have signal_date.
    SELECT ae.id INTO earliest_event_id
    FROM attribution_events ae
    JOIN tangential_signals ts ON ts.id = ae.signal_id
    WHERE ae.wedding_id = NEW.id
      AND ae.reverted_at IS NULL
      AND ae.bucket = 'attribution'
      AND ts.signal_date IS NOT NULL
    ORDER BY ts.signal_date ASC
    LIMIT 1;

    -- Step 3: COALESCE handles the NULL earliest case. When
    -- earliest_event_id IS NULL, (id = NULL) = NULL → COALESCE
    -- to false → every row gets is_first_touch=false. Matches the
    -- TS service's behavior (no first touch when no attribution
    -- rows). Schema's NOT NULL constraint is honored.
    UPDATE attribution_events
    SET is_first_touch = COALESCE(id = earliest_event_id, false)
    WHERE wedding_id = NEW.id
      AND reverted_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION recompute_attribution_state() IS
  'Recompute attribution_events.bucket AND is_first_touch atomically '
  'when weddings.inquiry_date moves. NULL-safe via COALESCE on the '
  'is_first_touch comparison — no-attribution-events case sets all '
  'to false rather than throwing NOT NULL violation. Per Playbook '
  'INV-2.5 / Part 12.3.';
