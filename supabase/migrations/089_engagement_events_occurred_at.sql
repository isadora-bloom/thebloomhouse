-- ============================================
-- 089: engagement_events.occurred_at
--
-- Separates the *real* time an event happened (when an email landed,
-- when a tour was booked) from the row's DB insert time. Heat-score
-- decay uses occurred_at so historical backfill from onboarding
-- decays against the email's original date, not against "today".
--
-- Without this, a venue that connects Gmail and imports 90 days of
-- history would see every old inquiry stamped at now(), decay factor
-- 1.0, and the leaderboard would spike to a wall of hot leads.
--
-- Backfill rule for existing rows: occurred_at = created_at. That
-- preserves current behaviour for everything recorded up to this
-- migration. New rows default to now() if the caller doesn't supply
-- an explicit occurred_at (live email pipeline does supply it, but
-- cron-origin events like decay ticks don't need to).
-- ============================================

ALTER TABLE engagement_events ADD COLUMN IF NOT EXISTS occurred_at timestamptz;

UPDATE engagement_events
SET occurred_at = created_at
WHERE occurred_at IS NULL;

ALTER TABLE engagement_events ALTER COLUMN occurred_at SET NOT NULL;
ALTER TABLE engagement_events ALTER COLUMN occurred_at SET DEFAULT now();

-- Recalc reads by (wedding_id, occurred_at desc) — existing
-- (wedding_id, created_at) index doesn't cover the new order column.
CREATE INDEX IF NOT EXISTS engagement_events_wedding_occurred_idx
  ON engagement_events(wedding_id, occurred_at DESC);
