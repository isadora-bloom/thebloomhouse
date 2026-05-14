-- ---------------------------------------------------------------------------
-- 340_weather_climate_norms.sql
-- ---------------------------------------------------------------------------
-- Anchor: TIER 6+ (2026-05-14). The TIER 6 weather page is forward-
-- looking only (14d forecast + tours/weddings overlay). Coordinators
-- planning a tour calendar or briefing a couple six months out asked
-- for the inverse view: "what is May like historically at 4pm at this
-- venue, and is it trending hotter/wetter than the prior decade?"
--
-- This migration adds a pre-aggregated month-by-hour climate table.
-- Open-Meteo's free ERA5 archive returns hourly data back to 1940;
-- we fetch the last 20 years and bucket into month × hour cells. Two
-- decade buckets are stored side-by-side so the page can show both
-- the typical condition AND the trend delta in one shot.
--
-- Volume: 12 months × 24 hours = 288 rows per venue. Tiny.
-- Refresh cadence: annual. Climate norms do not move overnight. The
-- backfill service is operator-triggered + dispatched by an annual
-- cron sweep (added in same TIER).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ON CONFLICT in the writer.

CREATE TABLE IF NOT EXISTS public.weather_climate_norms (
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  month_num int NOT NULL CHECK (month_num BETWEEN 1 AND 12),
  hour_local int NOT NULL CHECK (hour_local BETWEEN 0 AND 23),

  -- Recent decade (most recent 10 years up to the refresh date).
  recent_temp_avg_f decimal,
  recent_temp_p10_f decimal,
  recent_temp_p90_f decimal,
  recent_precip_avg_in decimal,
  recent_precip_prob_pct decimal,
  recent_sample_count int NOT NULL DEFAULT 0,

  -- Prior decade (10 years preceding the recent window).
  prior_temp_avg_f decimal,
  prior_precip_avg_in decimal,
  prior_precip_prob_pct decimal,
  prior_sample_count int NOT NULL DEFAULT 0,

  -- Decade boundaries stamped at compute time so the UI can label
  -- the comparison precisely ("2016-2025 vs 2006-2015"). Stored once
  -- per row but constant across a single refresh — kept on the row
  -- so a partial refresh that touches some month-hours but not others
  -- still has the right labels.
  recent_window_start date,
  recent_window_end date,
  prior_window_start date,
  prior_window_end date,

  refreshed_at timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (venue_id, month_num, hour_local)
);

-- Page reads "give me all hours for this month for this venue".
CREATE INDEX IF NOT EXISTS weather_climate_norms_venue_month_idx
  ON public.weather_climate_norms (venue_id, month_num);

-- RLS: read-only for the venue's operators. Service-role writes via
-- the climate-norms backfill service.
ALTER TABLE public.weather_climate_norms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weather_climate_norms_select_own
  ON public.weather_climate_norms;
CREATE POLICY weather_climate_norms_select_own
  ON public.weather_climate_norms
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS weather_climate_norms_super_admin
  ON public.weather_climate_norms;
CREATE POLICY weather_climate_norms_super_admin
  ON public.weather_climate_norms
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON TABLE public.weather_climate_norms IS
  'Per-venue month × hour-of-day climate aggregates with recent-decade '
  'vs prior-decade trend comparison. Refreshed annually via the '
  'climate-norms backfill service. TIER 6+ (2026-05-14).';
