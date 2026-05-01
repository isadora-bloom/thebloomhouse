-- Migration 118: Attribution bucket recompute on inquiry_date change
--
-- Per Playbook INV-2.5 + Part 12.3:
--   "If a wedding's inquiry_date (point zero timestamp) is corrected,
--    every attribution event's bucket (pre_zero / post_zero) must be
--    recomputed. Stale buckets produce wrong analytics."
--
-- Pre-fix: candidate-resolver.recomputeFirstTouch handled is_first_touch
-- but NOT bucket. attribution_events.bucket was computed at INSERT time
-- using the inquiry_date snapshot at that moment; if inquiry_date later
-- moved (coordinator override, source-backtrace adjustment, future
-- correction-tooling) the bucket stayed stale.
--
-- Two-layer fix:
--   1. (this migration) Postgres trigger on weddings UPDATE OF
--      inquiry_date — fires automatically, can never be forgotten by
--      a code path.
--   2. (companion service) recomputeBucketsForWedding service helper
--      that callers can also invoke explicitly. Belt-and-braces
--      protection so coordinator code paths can be reasoned about
--      both at the DB and the service layer.

CREATE OR REPLACE FUNCTION recompute_attribution_buckets() RETURNS TRIGGER AS $$
BEGIN
  -- Only react when inquiry_date actually changed. Saves the trigger
  -- from firing on every weddings UPDATE for unrelated columns.
  IF OLD.inquiry_date IS DISTINCT FROM NEW.inquiry_date THEN
    -- Recompute bucket for every live attribution_event on this
    -- wedding. Bucket logic mirrors candidate-resolver.ts:550 so the
    -- DB-side recompute matches what the service-side INSERT path
    -- would produce.
    --
    -- Rule: signal_date >= inquiry_date → 'nurture' (post-point-zero
    --       touch). signal_date < inquiry_date → 'attribution' (pre-
    --       point-zero touch — the touch that brought them in).
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
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS weddings_inquiry_date_recompute_buckets ON weddings;
CREATE TRIGGER weddings_inquiry_date_recompute_buckets
  AFTER UPDATE OF inquiry_date ON weddings
  FOR EACH ROW
  EXECUTE FUNCTION recompute_attribution_buckets();

COMMENT ON FUNCTION recompute_attribution_buckets() IS
  'Per Playbook INV-2.5 / Part 12.3: when weddings.inquiry_date moves, '
  'every attribution_events.bucket on that wedding must be recomputed '
  'against the new boundary. Bucket logic mirrors candidate-resolver '
  'INSERT-time computation (signal_date >= inquiry_date → nurture).';
