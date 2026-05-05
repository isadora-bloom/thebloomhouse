-- Migration 212: error_logs RLS + correlation_id column
--
-- GAP C1 (CRITICAL): error_logs was created in migration 009 without RLS
-- enabled. Any authenticated session could SELECT * FROM error_logs and read
-- every venue's pipeline error trail, exposing email addresses, thread ids,
-- and stack traces across the entire tenant population.
--
-- GAP H2 (HIGH): error_logs has no correlation_id column, so the forensic
-- chain established in migrations 128 + 160 (api_costs / drafts /
-- interactions / engagement_events / admin_notifications) has a gap:
-- pipeline errors that fire during a processIncomingEmail run cannot be
-- joined back to the originating inbound event by correlation_id alone.
--
-- This migration:
--   1. Enables RLS on error_logs.
--   2. Adds a venue-coordinator SELECT policy scoped to the authenticated
--      user's venue (via user_profiles.venue_id). The service role client
--      used by the pipeline bypasses RLS, so no INSERT policy is needed.
--   3. Adds correlation_id text column + partial index so error rows can
--      be joined to the rest of the forensic chain on a single ID.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS.

-- 1. Enable RLS
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

-- 2. Venue-scoped SELECT policy
CREATE POLICY "error_logs_venue_select" ON error_logs
  FOR SELECT USING (
    venue_id = (
      SELECT v.id FROM venues v
      JOIN user_profiles up ON up.id = auth.uid()
      WHERE v.id = up.venue_id
    )
  );

-- 3. correlation_id column + index
ALTER TABLE error_logs ADD COLUMN IF NOT EXISTS correlation_id TEXT;

CREATE INDEX IF NOT EXISTS error_logs_correlation_id_idx
  ON error_logs (correlation_id)
  WHERE correlation_id IS NOT NULL;

COMMENT ON COLUMN error_logs.correlation_id IS
  'Request-scoped uuid minted at processIncomingEmail entry. Joins to '
  'api_costs / drafts / interactions / engagement_events / '
  'admin_notifications on the same id, completing the forensic chain '
  'for one inbound event. NULL for cron-driven errors (e.g. autosend '
  'flush) where no inbound event correlation id exists. Per T5-eta.3.';
