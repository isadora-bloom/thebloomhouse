-- Migration 160: extend correlation_id to engagement_events / interactions
-- / admin_notifications / intelligence_insights (T5-η.3).
--
-- Migration 128 added correlation_id to api_costs + drafts. The forensic
-- record stops there: a coordinator debugging "what fired off this
-- inbound email" can chase the cost rows + the draft, but cannot trace
-- the same id through the engagement_event the email created, the
-- interaction row that was inserted, the notifications fanned out, or
-- the intelligence_insight that may have been (in)validated.
--
-- This migration extends the correlation_id thread so a single SQL
-- query joining on correlation_id returns the full lineage of one
-- inbound event across every downstream side effect.
--
-- Type: text — matches the existing api_costs.correlation_id and
-- drafts.correlation_id (migration 128) so cross-table joins don't
-- need casts.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS.
-- Notifications live on the admin_notifications table; the source
-- doctrine name is "notifications" but the on-disk table is
-- admin_notifications since migration 002.

ALTER TABLE engagement_events
  ADD COLUMN IF NOT EXISTS correlation_id text;

ALTER TABLE interactions
  ADD COLUMN IF NOT EXISTS correlation_id text;

ALTER TABLE admin_notifications
  ADD COLUMN IF NOT EXISTS correlation_id text;

ALTER TABLE intelligence_insights
  ADD COLUMN IF NOT EXISTS correlation_id text;

CREATE INDEX IF NOT EXISTS idx_engagement_events_correlation_id
  ON engagement_events (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_interactions_correlation_id
  ON interactions (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_notifications_correlation_id
  ON admin_notifications (correlation_id)
  WHERE correlation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_intelligence_insights_correlation_id
  ON intelligence_insights (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON COLUMN engagement_events.correlation_id IS
  'Request-scoped uuid threaded by the structured logger. Lets a '
  'coordinator query "all engagement events fired while processing '
  'this inbound email" with a single ID. Per T5-eta.3 / OPS-21.2.1.';

COMMENT ON COLUMN interactions.correlation_id IS
  'Request-scoped uuid that ties this interaction back to the inbound '
  'event that produced it. Joins to api_costs / drafts / '
  'engagement_events / admin_notifications / intelligence_insights '
  'on the same id. Per T5-eta.3.';

COMMENT ON COLUMN admin_notifications.correlation_id IS
  'Request-scoped uuid of the inbound event that fanned this '
  'notification out. Per T5-eta.3.';

COMMENT ON COLUMN intelligence_insights.correlation_id IS
  'Request-scoped uuid of the inbound event or coordinator click that '
  'caused this insight to be (re)generated. Per T5-eta.3.';
