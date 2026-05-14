-- ---------------------------------------------------------------------------
-- 341_weather_anomaly_events.sql
-- ---------------------------------------------------------------------------
-- Anchor: TIER 6+ (2026-05-14). The climate_norms table from mig 340
-- answers "what's typical at this venue in May at 4pm". Coordinators
-- also asked for the inverse: "remember the three-week sub-zero stretch
-- last February when we did almost no tours" — i.e. surfacing notable
-- past weather events with their operational impact so pricing and
-- expectation-setting conversations have real ground truth.
--
-- This migration adds a thin events table populated during the climate-
-- norms backfill. Heuristics detect cold snaps, heat waves, wet
-- stretches, and severe-storm days from the 20-year Open-Meteo archive;
-- the writer joins interactions + tours from the same windows so each
-- event row carries "during X period: Y inquiries vs Z typical, A tours
-- vs B typical".
--
-- Storage is bounded: severity-ranked top-50 events per venue. The
-- backfill replaces the set each annual refresh, so the table never
-- accumulates.

CREATE TABLE IF NOT EXISTS public.weather_anomaly_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('cold_snap', 'heat_wave', 'wet_stretch', 'severe_storm', 'snow_event')),
  start_date date NOT NULL,
  end_date date NOT NULL,
  duration_days int NOT NULL,
  severity text NOT NULL CHECK (severity IN ('moderate', 'severe', 'extreme')),

  -- What happened. Human-readable summary the page renders verbatim
  -- and the numeric fields the UI can re-format.
  description text NOT NULL,
  min_temp_f decimal,
  max_temp_f decimal,
  total_precip_in decimal,
  total_snow_in decimal,

  -- Operational impact. NULL when the venue has no interaction history
  -- in that window (pre-onboarding) — UI hides the impact section
  -- rather than show zeros that are misleading.
  inquiries_during int,
  inquiries_typical int,
  tours_during int,
  tours_typical int,

  refreshed_at timestamptz NOT NULL DEFAULT now(),

  -- A venue cannot have two events of the same type starting the same
  -- date. Re-running the backfill upserts on (venue_id, start_date,
  -- event_type).
  UNIQUE (venue_id, start_date, event_type)
);

-- Page reads "recent events for this venue, newest first".
CREATE INDEX IF NOT EXISTS weather_anomaly_events_venue_start_idx
  ON public.weather_anomaly_events (venue_id, start_date DESC);

-- Calendar filter ("what happened in Feb 2025") uses both venue + month
-- of start_date. Postgres prefers a btree on the start_date itself for
-- the BETWEEN scan.
CREATE INDEX IF NOT EXISTS weather_anomaly_events_date_idx
  ON public.weather_anomaly_events (venue_id, start_date);

ALTER TABLE public.weather_anomaly_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS weather_anomaly_events_select_own
  ON public.weather_anomaly_events;
CREATE POLICY weather_anomaly_events_select_own
  ON public.weather_anomaly_events
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
    )
  );

DROP POLICY IF EXISTS weather_anomaly_events_super_admin
  ON public.weather_anomaly_events;
CREATE POLICY weather_anomaly_events_super_admin
  ON public.weather_anomaly_events
  FOR ALL TO authenticated
  USING (public.is_super_admin())
  WITH CHECK (public.is_super_admin());

COMMENT ON TABLE public.weather_anomaly_events IS
  'Notable past weather events at the venue with joined ops impact '
  '(inquiries / tours during the window vs typical for that month). '
  'Refreshed by the climate-norms backfill, top 50 events per venue. '
  'TIER 6+ (2026-05-14).';
