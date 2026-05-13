-- Migration 332: non-couple wedding tombstone columns.
--
-- Step 5c (RM-1123, 2026-05-13). Adds a soft-tombstone mechanism for
-- weddings that turned out to be non-couples (bus drivers, vendors,
-- autoreplies, wrong-numbers). Pre-fix, the SMS path minted weddings
-- unconditionally; Step 5b added an intent gate to stop NEW ghost
-- mints, but the ~292 existing Unknown weddings at Rixey still need
-- a cleanup mechanism. This migration is what makes that cleanup
-- visible to readers.
--
-- Design:
--   * non_couple_at = timestamp the classifier (or operator) flagged
--     the wedding as not-a-couple. NULL = couple wedding (active).
--   * non_couple_reason = free-text rationale. For classifier-flagged
--     rows: 'intent:<class>' (e.g. 'intent:vendor_communication'). For
--     operator-flagged rows: 'operator:<note>'.
--
-- Readers that should filter on non_couple_at IS NULL:
--   - leads list (every UI surface that counts active weddings)
--   - resolver wedding-picker (so a phone re-match doesn't attach a
--     new signal to a tombstoned non-couple wedding)
--   - Wave 4 identity judge enqueue (no point reconstructing a vendor)
--   - heat-map / engagement views
--
-- Hard rule: never DELETE. Soft-tombstone preserves the forensic
-- record per the Constitution (bloom-constitution.md).

ALTER TABLE weddings
  ADD COLUMN IF NOT EXISTS non_couple_at timestamptz,
  ADD COLUMN IF NOT EXISTS non_couple_reason text;

-- Index supports the read-side filter on most leads-list queries
-- (WHERE non_couple_at IS NULL is the common case). Partial index
-- keeps it small — most rows are couple weddings and never need to
-- be filtered out.
CREATE INDEX IF NOT EXISTS idx_weddings_non_couple_at
  ON weddings (venue_id, non_couple_at)
  WHERE non_couple_at IS NOT NULL;

-- Audit comment for future migrations.
COMMENT ON COLUMN weddings.non_couple_at IS
  'Soft-tombstone marker: when set, this wedding has been classified as not-a-couple (bus driver, vendor, autoreply, wrong-number). Readers filter on non_couple_at IS NULL. Never set via DELETE. See bloom-identity-resolution-doctrine.md G3 / RM-1123.';

COMMENT ON COLUMN weddings.non_couple_reason IS
  'Free-text rationale paired with non_couple_at. Classifier-set rows use intent:<class>; operator-set rows use operator:<note>.';
