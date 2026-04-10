-- ============================================
-- seed-weather.sql
-- ============================================
-- Seeds 3 years (2024, 2025, partial 2026) of monthly climate-normal
-- weather rows for all four Crestwood Collection venues. The metrics
-- power the Outdoor Event Score trend chart on the Market Pulse page.
--
-- Source: 'climate_norm' — these are monthly averages, not daily obs.
-- One row per venue / year / month. `date` is the first of the month.
-- ============================================

-- Clear any prior climate-normal rows so this script is idempotent.
DELETE FROM weather_data
WHERE source = 'climate_norm'
  AND venue_id IN (
    '22222222-2222-2222-2222-222222222201',
    '22222222-2222-2222-2222-222222222202',
    '22222222-2222-2222-2222-222222222203',
    '22222222-2222-2222-2222-222222222204'
  );

-- All four Crestwood venues share the same regional climate normals
-- (Virginia / DC metro) so we seed the same rows for each.
INSERT INTO weather_data (
  venue_id, date, year, month,
  high_temp, low_temp, precipitation, conditions, source,
  avg_temp_4pm_f, avg_humidity_pct, avg_wind_mph, sunny_days, outdoor_event_score
)
SELECT
  v.venue_id,
  make_date(d.year, d.month, 1) AS date,
  d.year, d.month,
  d.avg_temp_4pm_f AS high_temp,
  d.avg_temp_4pm_f - 18 AS low_temp,
  d.precipitation,
  d.conditions,
  'climate_norm' AS source,
  d.avg_temp_4pm_f,
  d.avg_humidity_pct,
  d.avg_wind_mph,
  d.sunny_days,
  d.outdoor_event_score
FROM (
  VALUES
    ('22222222-2222-2222-2222-222222222201'::uuid),
    ('22222222-2222-2222-2222-222222222202'::uuid),
    ('22222222-2222-2222-2222-222222222203'::uuid),
    ('22222222-2222-2222-2222-222222222204'::uuid)
) AS v(venue_id)
CROSS JOIN (
  VALUES
    -- 2024
    (2024,  1, 42, 2.8, 58,  9, 12, 55, 'Cold'),
    (2024,  2, 46, 2.5, 55, 10, 13, 58, 'Cool'),
    (2024,  3, 58, 3.4, 57, 11, 15, 62, 'Mild Spring'),
    (2024,  4, 67, 3.1, 56, 10, 17, 74, 'Ideal Spring'),
    (2024,  5, 74, 4.0, 62,  8, 18, 65, 'Warm Spring'),
    (2024,  6, 82, 3.8, 68,  7, 20, 58, 'Hot'),
    (2024,  7, 88, 4.2, 72,  6, 21, 35, 'Very Hot'),
    (2024,  8, 87, 3.9, 73,  6, 20, 37, 'Very Hot'),
    (2024,  9, 80, 3.5, 67,  7, 19, 55, 'Warm Fall'),
    (2024, 10, 68, 3.0, 60,  8, 18, 75, 'Ideal Fall'),
    (2024, 11, 55, 3.2, 60,  9, 14, 65, 'Cool Fall'),
    (2024, 12, 44, 2.9, 60, 10, 11, 52, 'Cold'),
    -- 2025
    (2025,  1, 44, 3.0, 59,  9, 11, 53, 'Cold'),
    (2025,  2, 48, 2.7, 56, 10, 12, 57, 'Cool'),
    (2025,  3, 60, 3.6, 58, 11, 14, 60, 'Mild Spring'),
    (2025,  4, 69, 3.3, 57, 10, 16, 72, 'Ideal Spring'),
    (2025,  5, 76, 4.2, 63,  8, 17, 62, 'Warm Spring'),
    (2025,  6, 84, 4.0, 69,  7, 19, 54, 'Hot'),
    (2025,  7, 90, 4.5, 74,  6, 20, 30, 'Very Hot'),
    (2025,  8, 89, 4.1, 75,  6, 19, 32, 'Very Hot'),
    (2025,  9, 82, 3.7, 68,  7, 18, 52, 'Warm Fall'),
    (2025, 10, 70, 3.2, 61,  8, 17, 73, 'Ideal Fall'),
    (2025, 11, 57, 3.4, 61,  9, 13, 63, 'Cool Fall'),
    (2025, 12, 46, 3.1, 61, 10, 10, 50, 'Cold'),
    -- 2026 (Jan–Apr; Apr is projected)
    (2026,  1, 45, 3.1, 60,  9, 11, 52, 'Cold'),
    (2026,  2, 50, 2.9, 57, 10, 12, 56, 'Cool'),
    (2026,  3, 62, 3.8, 59, 11, 13, 58, 'Mild Spring'),
    (2026,  4, 70, 3.4, 60, 10, 15, 60, 'Ideal Spring (Projected)')
) AS d(year, month, avg_temp_4pm_f, precipitation, avg_humidity_pct, avg_wind_mph, sunny_days, outdoor_event_score, conditions);
