-- ============================================
-- 035: Weather metrics expansion
-- ============================================
-- Adds richer outdoor-event metrics to weather_data so Market Pulse
-- can render a 3-year trend chart with climate-normal aggregates.
-- ============================================

ALTER TABLE weather_data ADD COLUMN IF NOT EXISTS avg_temp_4pm_f integer;
ALTER TABLE weather_data ADD COLUMN IF NOT EXISTS avg_humidity_pct integer;
ALTER TABLE weather_data ADD COLUMN IF NOT EXISTS avg_wind_mph integer;
ALTER TABLE weather_data ADD COLUMN IF NOT EXISTS sunny_days integer;
ALTER TABLE weather_data ADD COLUMN IF NOT EXISTS outdoor_event_score integer;
ALTER TABLE weather_data ADD COLUMN IF NOT EXISTS year integer;
ALTER TABLE weather_data ADD COLUMN IF NOT EXISTS month integer;

CREATE INDEX IF NOT EXISTS idx_weather_data_year_month
  ON weather_data(year, month);

COMMENT ON COLUMN weather_data.avg_temp_4pm_f IS 'Average afternoon (4pm) temperature for the month in Fahrenheit';
COMMENT ON COLUMN weather_data.avg_humidity_pct IS 'Average relative humidity for the month (0-100)';
COMMENT ON COLUMN weather_data.avg_wind_mph IS 'Average wind speed for the month in mph';
COMMENT ON COLUMN weather_data.sunny_days IS 'Number of predominantly sunny days in the month';
COMMENT ON COLUMN weather_data.outdoor_event_score IS 'Composite 0-100 outdoor event suitability score';
COMMENT ON COLUMN weather_data.year IS 'Year for monthly climate-normal rows';
COMMENT ON COLUMN weather_data.month IS 'Month (1-12) for monthly climate-normal rows';
