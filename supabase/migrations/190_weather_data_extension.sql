-- ---------------------------------------------------------------------------
-- 190_weather_data_extension.sql  (T5-Rixey-ZZ / Z7 weather × cancellation)
-- ---------------------------------------------------------------------------
-- Why: the new weather × tour-cancellation insight service
-- (src/lib/services/insights/weather-cancellation.ts) joins
-- tours.scheduled_at::date against weather_data.date for each venue.
-- The existing schema already supports the join (003_intel_tables +
-- 008_venue_location_fields + 035_weather_metrics), but two things
-- need to land on production for the insight to fire on Rixey:
--
--   1. Rixey Manor's venue row needs lat/lon set so weather forecasts
--      can be pulled (Open-Meteo cron at vercel.json key
--      'weather_forecast'). Without it, weather_data stays empty for
--      the venue and the insight gates with reason='no_weather_data'.
--
--   2. A composite index on weather_data (venue_id, date) is helpful
--      for the join — the existing schema only has the pkey + the
--      year/month index (idx_weather_data_year_month from 035). The
--      service's query .eq('venue_id', X).gte('date', start) hits a
--      seq-scan without it.
--
-- Rixeyville, VA is approximately 38.6943°N, -77.9039°W (per Z7 brief).
-- The venue row's NOAA station id is set elsewhere via onboarding; the
-- coordinate fields are the gate for Open-Meteo forecasts.
--
-- Idempotent: CREATE INDEX IF NOT EXISTS, conditional UPDATE only when
-- lat/lon are NULL (won't overwrite an already-set venue row).
-- ---------------------------------------------------------------------------

BEGIN;

-- Composite index supporting the weather-cancellation service's read
-- pattern: per-venue lookups across a date window.
CREATE INDEX IF NOT EXISTS idx_weather_data_venue_date
  ON public.weather_data (venue_id, date);

COMMENT ON INDEX public.idx_weather_data_venue_date IS
  'Supports weather × tour-cancellation insight (T5-Rixey-ZZ / Z7) and '
  'the venue weather chart on the Market Pulse page.';

-- Ensure Rixey Manor has lat/lon set so the Open-Meteo weather cron
-- starts populating weather_data for the venue. The venue id is the
-- one referenced by scripts/backfill-rixey-history.ts. Coordinate
-- update is GUARDED — only runs when lat AND lon are NULL, so this
-- migration can replay safely on any environment.
UPDATE public.venues
SET
  latitude = 38.6943,
  longitude = -77.9039
WHERE id = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
  AND (latitude IS NULL OR longitude IS NULL);

COMMIT;
