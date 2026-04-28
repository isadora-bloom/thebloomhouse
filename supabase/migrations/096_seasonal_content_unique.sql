-- ---------------------------------------------------------------------------
-- 096_seasonal_content_unique.sql
-- ---------------------------------------------------------------------------
-- Add a unique constraint on (venue_id, season) to venue_seasonal_content
-- so the new coordinator UI's upsert path has a stable conflict target.
--
-- Pre-condition: dedup any pre-existing rows that violate the
-- constraint (the current schema lets you insert two 'spring' rows for
-- the same venue). Keep the most-recently-created row per (venue,
-- season) and drop the rest.
-- ---------------------------------------------------------------------------

-- 1. Dedup any existing duplicates: keep the latest by created_at.
DELETE FROM public.venue_seasonal_content a
 USING public.venue_seasonal_content b
 WHERE a.venue_id = b.venue_id
   AND a.season = b.season
   AND a.created_at < b.created_at;

-- 2. Add the unique constraint.
ALTER TABLE public.venue_seasonal_content
  DROP CONSTRAINT IF EXISTS venue_seasonal_content_venue_season_unique;
ALTER TABLE public.venue_seasonal_content
  ADD CONSTRAINT venue_seasonal_content_venue_season_unique
  UNIQUE (venue_id, season);

NOTIFY pgrst, 'reload schema';
