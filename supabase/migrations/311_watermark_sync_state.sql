-- Migration 311: Watermark sync state for FRED + Zoom
--
-- Pattern 4 from BLOOM-PATTERNS-ZOOM-OUT.md: external integrations
-- were re-pulling their entire historical window on every tick.
--
--   1. FRED economic data refetched ~400 days every nightly cron.
--   2. Zoom polling refetched the full 30-day window every tick.
--
-- The OpenPhone watermark pattern (openphone_connections.last_synced_at,
-- mig 097) is the reference shape: store a last-success timestamp,
-- read with a small overlap buffer on the next sync. This migration
-- gives FRED and Zoom equivalent watermark surfaces.
--
-- Idempotent. Statement-level. No transaction wrapper (Wave 23 doctrine).

-- fred_series_sync_state -----------------------------------------------------

CREATE TABLE IF NOT EXISTS public.fred_series_sync_state (
  series_id text PRIMARY KEY,
  last_fetched_at timestamptz,
  last_error_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.fred_series_sync_state IS
  'owner:agent. Per-FRED-series watermark for incremental fetch. fred-fetch.ts reads last_fetched_at and pulls from (last_fetched_at - 1 day) to today, instead of re-pulling 400 days every cron tick. last_error_at + last_error capture transient failures without poisoning the success watermark. First sync (row absent) falls back to the 400-day backfill.';


-- zoom_connections.last_synced_at -------------------------------------------
--
-- zoom_connections is defined in mig 097. It already has updated_at +
-- created_at. We add last_synced_at so the polling cron can resume from
-- the last successful sync rather than re-pulling 30d every tick. The
-- 30-min overlap buffer in the reader handles meetings whose finalize
-- step lands after our previous watermark.

ALTER TABLE public.zoom_connections
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

COMMENT ON COLUMN public.zoom_connections.last_synced_at IS
  'Watermark for incremental Zoom recording sync. NULL means first-sync (use 30d default). zoom.ts subtracts a 30-minute overlap to catch meetings that finalized after the previous tick.';
