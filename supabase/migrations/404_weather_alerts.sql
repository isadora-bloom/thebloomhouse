-- ---------------------------------------------------------------------------
-- 404_weather_alerts.sql
-- ---------------------------------------------------------------------------
-- W49 (November plan, wave 7). Two tables:
--
-- 1. weather_alerts — a real severity feed via the National Weather
--    Service "alerts for a point" API (api.weather.gov/alerts/active),
--    replacing the dead keyword branch in
--    src/lib/services/insights/weather-cancellation.ts's `bucketWeather`.
--    That function checked the Open-Meteo `conditions` string for the
--    literal words "tornado" / "hurricane", but Open-Meteo's weathercode
--    mapping never produces those strings — the checks never fired.
--    Refreshed inside the existing `weather_forecast` cron case (no new
--    cron entry; src/lib/services/intel/nws-alerts.ts owns the fetch +
--    upsert). Rows are never deleted, only flipped `is_active=false` on
--    expiry, so the cancellation analyzer can join historical tour dates
--    against real alert windows going forward.
--
-- 2. weather_climate_annual — per-year, per-month aggregates (mean daily
--    high, total precipitation) from the same Open-Meteo archive the
--    weather_climate_norms backfill (migration 340) already fetches.
--    weather_climate_norms only stores two decade-aggregate buckets
--    (recent 10y vs prior 10y), which is a two-point comparison, not a
--    trend. This table gives src/lib/services/intel/climate-context.ts
--    enough points to compute a real least-squares slope across every
--    available year. Bundled into this migration because the workstream
--    only owns migration 404 (no second migration number available).
--
-- Both RLS policy sets copy the canonical venue-isolation pattern from
-- migration 383 (own venue OR org sibling OR super-admin; service_role
-- unrestricted; demo anon read gated to is_demo venues) so
-- check-rls-on-venue-id.mjs passes without an allowlist entry.
--
-- No BEGIN/COMMIT wrapper, per repo convention (feedback_migration_no_
-- transaction_wrapper).

CREATE TABLE IF NOT EXISTS public.weather_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  -- NWS's own alert id (a stable URI). Unique per venue so the same
  -- physical alert refreshed twice a day upserts onto one row.
  nws_id text NOT NULL,
  event text,
  severity text,
  certainty text,
  urgency text,
  headline text,
  description text,
  instruction text,
  area_desc text,
  status text,
  message_type text,
  onset timestamptz,
  ends timestamptz,
  expires timestamptz,
  -- Flips false when a refresh no longer sees this alert (expired or
  -- cancelled). Rows are kept, not deleted, for historical join.
  is_active boolean NOT NULL DEFAULT true,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (venue_id, nws_id)
);

CREATE INDEX IF NOT EXISTS weather_alerts_venue_active_idx
  ON public.weather_alerts (venue_id, is_active);
CREATE INDEX IF NOT EXISTS weather_alerts_venue_onset_idx
  ON public.weather_alerts (venue_id, onset);

ALTER TABLE public.weather_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weather_alerts_select" ON public.weather_alerts;
CREATE POLICY "weather_alerts_select" ON public.weather_alerts
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "weather_alerts_service" ON public.weather_alerts;
CREATE POLICY "weather_alerts_service" ON public.weather_alerts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_weather_alerts" ON public.weather_alerts;
CREATE POLICY "demo_anon_select_weather_alerts" ON public.weather_alerts
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMENT ON TABLE public.weather_alerts IS
  'NWS alerts/active feed per venue (api.weather.gov). Refreshed inside '
  'the weather_forecast cron via src/lib/services/intel/nws-alerts.ts. '
  'is_active flips false on expiry; rows persist for historical join in '
  'weather-cancellation.ts. W49 wave 7, 2026-09.';

-- ---------------------------------------------------------------------------
-- weather_climate_annual
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.weather_climate_annual (
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  year int NOT NULL,
  month_num int NOT NULL CHECK (month_num BETWEEN 1 AND 12),
  mean_high_f decimal,
  total_precip_in decimal,
  sample_days int NOT NULL DEFAULT 0,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (venue_id, year, month_num)
);

CREATE INDEX IF NOT EXISTS weather_climate_annual_venue_month_idx
  ON public.weather_climate_annual (venue_id, month_num);

ALTER TABLE public.weather_climate_annual ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "weather_climate_annual_select" ON public.weather_climate_annual;
CREATE POLICY "weather_climate_annual_select" ON public.weather_climate_annual
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "weather_climate_annual_service" ON public.weather_climate_annual;
CREATE POLICY "weather_climate_annual_service" ON public.weather_climate_annual
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_weather_climate_annual" ON public.weather_climate_annual;
CREATE POLICY "demo_anon_select_weather_climate_annual" ON public.weather_climate_annual
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

COMMENT ON TABLE public.weather_climate_annual IS
  'Per-year, per-month climate aggregates (mean daily high, total '
  'precipitation) from the Open-Meteo archive backfill '
  '(weather-climate-norms.ts). Feeds the least-squares year-over-year '
  'trend in climate-context.ts. W49 wave 7, 2026-09.';
