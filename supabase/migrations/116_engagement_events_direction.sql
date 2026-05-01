-- Migration 116: engagement_events.direction
--
-- Adds the direction column required by Playbook Invariants 13–16:
--
--   INV-13: Every engagement event carries explicit direction at write time.
--   INV-14: Heat scores increment only on 'inbound' events.
--   INV-15: Autonomous sender / draft router never trigger on 'outbound'.
--   INV-16: Direction enforced at READ time by every consumer.
--
-- Pre-fix the column did not exist. Pipeline writers happened to fire
-- heat events only on inbound paths, so all historical rows are de
-- facto inbound — the audit (2026-04-30) verified this by tracing
-- recordEngagementEvent / recordEngagementEventsBatch callers and
-- finding that every site is reached only through processIncomingEmail
-- inbound branches or post-tour-brief (also inbound: the couple toured).
--
-- Backfill scheme decided 2026-05-01:
--   Full backfill from event_type semantics. Mark every existing row as
--   'inbound'. New rows after this migration land NOT NULL + CHECK
--   constrained, so writers must pass direction explicitly. Outbound
--   events were never written historically, so 'inbound' is the
--   correct historical truth, not a default-best-guess.

-- Step 1: Add column nullable so the alter doesn't fail on existing rows.
ALTER TABLE engagement_events
  ADD COLUMN IF NOT EXISTS direction text;

-- Step 2: Backfill all existing rows to 'inbound'.
-- Pipeline writers historically only fired heat events on inbound
-- paths (see audit 2026-04-30 STAGE-10.2.10 finding). Every event
-- that exists today is the result of a couple-side action observed
-- by Bloom — initial_inquiry, email_reply_received, tour_requested,
-- high_commitment_signal, family_mentioned, high_specificity,
-- sustained_engagement, payment_received, contract_signed,
-- portal_login. None are venue-originated.
UPDATE engagement_events
  SET direction = 'inbound'
  WHERE direction IS NULL;

-- Step 3: Lock the column NOT NULL + CHECK so writers must pass it
-- explicitly going forward. Defense-in-depth against the schema-level
-- invariant the playbook demands (INV-13).
ALTER TABLE engagement_events
  ALTER COLUMN direction SET NOT NULL;

ALTER TABLE engagement_events
  DROP CONSTRAINT IF EXISTS engagement_events_direction_check;
ALTER TABLE engagement_events
  ADD CONSTRAINT engagement_events_direction_check
    CHECK (direction IN ('inbound', 'outbound'));

COMMENT ON COLUMN engagement_events.direction IS
  'inbound = couple-to-venue (couple sent email, booked tour, paid, '
  'logged in to portal). outbound = venue-to-couple (auto-send, '
  'follow-up, coordinator reply). Heat scoring (recalculateHeatScore) '
  'and the autonomous sender / draft router consume only inbound. '
  'Required by Playbook Invariants 13–16.';

-- Step 4: Index for the inbound filter that's on every read consumer
-- after the heat / source-quality / anomaly / digest / insight / journey
-- / correlation updates land. Partial index on inbound = the hot path;
-- outbound rows are rarer and don't need their own index until they exist.
CREATE INDEX IF NOT EXISTS idx_engagement_events_inbound
  ON engagement_events (venue_id, wedding_id, occurred_at DESC)
  WHERE direction = 'inbound';
