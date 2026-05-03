-- ---------------------------------------------------------------------------
-- 180_source_attribution_unique.sql  (T5-Rixey-NN — bug #3)
-- ---------------------------------------------------------------------------
-- The cron writer at refreshAttributionAllVenues (src/app/api/cron/route.ts)
-- upserts source_attribution rows with onConflict='venue_id,source,period_start'.
-- Pre-fix there was no matching unique index, so PostgREST returned
--   "no unique or exclusion constraint matching the ON CONFLICT specification"
-- and every upsert silently wrote nothing. Stream MM hit this loading Rixey
-- and worked around it with delete-then-insert in the load script.
--
-- This migration adds the missing unique index so the production cron path
-- (and any future ON CONFLICT writer) actually idempotently upserts.
--
-- Idempotent: IF NOT EXISTS guard.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS uq_source_attribution_venue_source_period
  ON public.source_attribution (venue_id, source, period_start);

COMMENT ON INDEX public.uq_source_attribution_venue_source_period IS
  'Matches the ON CONFLICT key in refreshAttributionAllVenues (cron). '
  'Without this, the upsert silently fails. Per T5-Rixey-NN bug #3.';

COMMIT;

NOTIFY pgrst, 'reload schema';
