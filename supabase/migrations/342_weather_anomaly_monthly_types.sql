-- ---------------------------------------------------------------------------
-- 342_weather_anomaly_monthly_types.sql
-- ---------------------------------------------------------------------------
-- TIER 6+ follow-up. Operator asked for "last April was exceptionally
-- hot — should I expect more or fewer bookings this April?" The
-- short-duration anomaly types from mig 341 (cold_snap / heat_wave /
-- wet_stretch / severe_storm / snow_event) miss the case where a whole
-- month runs systematically warm/cool/wet/dry vs typical without
-- triggering any sub-week run.
--
-- This migration extends the event_type CHECK to include the four
-- monthly-deviation types. The backfill service computes monthly means
-- against the 10-year norm and emits one row per year-month where the
-- deviation exceeds the threshold.

ALTER TABLE public.weather_anomaly_events
  DROP CONSTRAINT IF EXISTS weather_anomaly_events_event_type_check;

ALTER TABLE public.weather_anomaly_events
  ADD CONSTRAINT weather_anomaly_events_event_type_check
  CHECK (event_type IN (
    'cold_snap',
    'heat_wave',
    'wet_stretch',
    'severe_storm',
    'snow_event',
    'warm_month',
    'cool_month',
    'wet_month',
    'dry_month'
  ));
