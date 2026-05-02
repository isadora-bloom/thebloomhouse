-- Migration 161: paused_period_skipped — replay queue for cost-ceiling
-- pauses (T5-eta.2).
--
-- Pre-this-migration: filterActiveVenues silently dropped paused
-- venues from cron services. A coordinator returning to the dashboard
-- after a 24h pause had no way to see WHAT didn't run — the digest
-- never appeared, the anomaly explanation never appeared, the weekly
-- briefing never appeared, but no surface said "we skipped these
-- because of the pause."
--
-- This table records every (venue, cron-tick, work_type) the gate
-- skipped during a paused window. A daily sweeper (00:05 UTC) builds
-- a notification per affected venue listing what was skipped, with a
-- one-click "Run now" backfill button.
--
-- Status lifecycle:
--   pending  → row inserted by filterActiveVenues during a pause.
--   replayed → coordinator clicked Run now (or auto-replay ran), and
--              the work was executed against current ceiling state.
--   expired  → ceiling pause cleared but coordinator never replayed
--              within 7 days; the work is no longer relevant (e.g. a
--              skipped digest from last Monday is stale by Friday).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS paused_period_skipped (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  -- Stable identifier for what was skipped — e.g. 'weekly_digest',
  -- 'weekly_briefing', 'monthly_briefing', 'anomaly_detection',
  -- 'follow_up_sequences', 'intelligence_analysis'. The replay
  -- sweeper groups counts by this.
  work_type text NOT NULL,
  -- When the work would have run if the venue weren't paused. For
  -- the hourly follow-up cron, this is the cron tick. For daily
  -- jobs, the day boundary.
  scheduled_for timestamptz NOT NULL,
  skipped_at timestamptz NOT NULL DEFAULT now(),
  -- Optional payload the cron handler can stash to make replay
  -- idempotent (e.g. the venueId list that was filtered, or the
  -- digest week-of-year). Most callers leave this null.
  payload jsonb DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'replayed', 'expired')),
  replayed_at timestamptz,
  replay_result jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE paused_period_skipped IS 'owner:agent. T5-eta.2 replay queue for cost-ceiling pauses. Coordinators see what was skipped during a paused window and can backfill.';

-- Sweeper queries by (venue_id, status) to find pending rows for the
-- daily summary. Composite index is the right shape for the lookup
-- shape "give me everything pending for venue X."
CREATE INDEX IF NOT EXISTS idx_paused_period_skipped_venue_status
  ON paused_period_skipped (venue_id, status, skipped_at DESC);

-- The /pulse banner counts by venue_id where status='pending', so a
-- partial index keyed on venue+pending is the right read-time shape.
CREATE INDEX IF NOT EXISTS idx_paused_period_skipped_pending
  ON paused_period_skipped (venue_id)
  WHERE status = 'pending';

-- RLS: same shape as cost_ceiling_warned_at telemetry — service-role
-- writes (cron + filterActiveVenues), platform-auth reads scoped to
-- venue. Keep the simple "venue scope" pattern from migration 142.
ALTER TABLE paused_period_skipped ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS paused_period_skipped_service_all ON paused_period_skipped;
CREATE POLICY paused_period_skipped_service_all ON paused_period_skipped
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Coordinators read their own venue's skipped rows via the shared
-- visible-venues RLS function (migration 141). Same shape as
-- marketing_channels / onboarding_projects.
DROP POLICY IF EXISTS paused_period_skipped_authenticated_select ON paused_period_skipped;
CREATE POLICY paused_period_skipped_authenticated_select ON paused_period_skipped
  FOR SELECT TO authenticated
  USING (
    venue_id IN (SELECT public.user_visible_venue_ids())
    OR public.is_super_admin()
  );
