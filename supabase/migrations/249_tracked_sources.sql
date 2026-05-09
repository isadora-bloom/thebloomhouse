-- Migration 249: tracked_sources — coordinator-curated freshness tracker.
--
-- Drives the source-freshness AI monitor + the curated /intel/sources/track
-- page. Each row asserts "venue X is actively tracking source Y on a
-- cadence of Z days." The freshness cron compares the row's expected
-- cadence against the most-recent marketing_spend (or other data signal)
-- and fires an admin_notifications reminder when the gap exceeds the
-- cadence — e.g. "Time to upload The Knot for May."
--
-- Lifecycle
-- ---------
--   - Coordinator opts in via /intel/sources/track. Inserts a row with
--     graveyard=false.
--   - Coordinator dismisses a single reminder via the notification bell.
--     Stamps last_dismissed_at; suppresses re-firing for 14 days.
--   - Coordinator opts out entirely via "Untrack" on the curated page.
--     Flips graveyard=true; future cron ticks skip the row but the
--     historical lineage is preserved (audit + opt-back-in).
--
-- The unique constraint on (venue_id, source_key) means the page can
-- safely upsert without dedup logic. graveyard rows are kept (never
-- deleted) so coordinator history is auditable.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS tracked_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  source_key text NOT NULL,
  expected_cadence_days integer NOT NULL DEFAULT 30,
  last_reminded_at timestamptz,
  last_dismissed_at timestamptz,
  graveyard boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, source_key)
);

COMMENT ON TABLE tracked_sources IS 'owner:intelligence — coordinator-curated source-freshness tracker. Drives /intel/sources/track + the source_freshness_reminder cron.';

CREATE INDEX IF NOT EXISTS idx_tracked_sources_venue
  ON tracked_sources (venue_id)
  WHERE graveyard = false;

CREATE INDEX IF NOT EXISTS idx_tracked_sources_active
  ON tracked_sources (venue_id, source_key)
  WHERE graveyard = false;

-- Keep updated_at fresh on UPDATE.
CREATE OR REPLACE FUNCTION public.tracked_sources_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tracked_sources_touch_updated_at ON tracked_sources;
CREATE TRIGGER trg_tracked_sources_touch_updated_at
  BEFORE UPDATE ON tracked_sources
  FOR EACH ROW
  EXECUTE FUNCTION public.tracked_sources_touch_updated_at();

ALTER TABLE tracked_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "auth_select_tracked_sources" ON tracked_sources;
CREATE POLICY "auth_select_tracked_sources" ON tracked_sources
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "auth_insert_tracked_sources" ON tracked_sources;
CREATE POLICY "auth_insert_tracked_sources" ON tracked_sources
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "auth_update_tracked_sources" ON tracked_sources;
CREATE POLICY "auth_update_tracked_sources" ON tracked_sources
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "auth_delete_tracked_sources" ON tracked_sources;
CREATE POLICY "auth_delete_tracked_sources" ON tracked_sources
  FOR DELETE TO authenticated USING (true);
