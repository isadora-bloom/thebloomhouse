-- ============================================================
-- BLOOM HOUSE — 6-MONTH INTELLIGENCE SEED
-- Period: October 2025 → March 2026
-- Venues: Rixey Manor, Crestwood Farm, The Glass House, Rose Hill Gardens
-- Run AFTER seed.sql — uses ON CONFLICT (id) DO NOTHING for safety
-- ============================================================
-- UUID prefix: eeee____ for all rows in this file
-- ============================================================

-- ============================================================
-- VENUE ID ALIASES (for readability)
-- ============================================================
-- Rixey Manor:    22222222-2222-2222-2222-222222222201  (enterprise, 200 cap, $8500)
-- Crestwood Farm: 22222222-2222-2222-2222-222222222202  (rustic barn, 150 cap, $6500)
-- The Glass House: 22222222-2222-2222-2222-222222222203 (modern urban, 250 cap, $12000)
-- Rose Hill Gardens: 22222222-2222-2222-2222-222222222204 (garden, 180 cap, $9500)
--
-- Coordinator IDs:
-- Sarah Chen (Rixey):  33333333-3333-3333-3333-333333333301
-- Jake Williams (CW):  33333333-3333-3333-3333-333333333302
-- Maya Patel (GH):     33333333-3333-3333-3333-333333333303
-- Olivia Ross (RH):    33333333-3333-3333-3333-333333333304

-- ============================================================
-- 1. SEARCH TRENDS — 6 months, monthly, 3 terms per venue
-- ============================================================
-- Pattern: "engagement ring" peaks Nov-Dec (holiday proposals)
--          "wedding venue" peaks Jan-Mar (booking season)
--          Venue-specific term follows seasonal wedding interest
-- Columns: id, venue_id, metro, term, week, interest

-- Rixey Manor (metro: US-VA-584)
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2025-10-01', 52),
  ('eeee0101-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2025-11-01', 48),
  ('eeee0101-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2025-12-01', 38),
  ('eeee0101-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2026-01-01', 72),
  ('eeee0101-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2026-02-01', 85),
  ('eeee0101-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'wedding venue', '2026-03-01', 93)
ON CONFLICT (id) DO NOTHING;

INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0001-0002-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2025-10-01', 58),
  ('eeee0101-0001-0002-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2025-11-01', 78),
  ('eeee0101-0001-0002-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2025-12-01', 95),
  ('eeee0101-0001-0002-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2026-01-01', 70),
  ('eeee0101-0001-0002-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2026-02-01', 82),
  ('eeee0101-0001-0002-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'engagement ring', '2026-03-01', 68)
ON CONFLICT (id) DO NOTHING;

INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0001-0003-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2025-10-01', 42),
  ('eeee0101-0001-0003-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2025-11-01', 38),
  ('eeee0101-0001-0003-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2025-12-01', 28),
  ('eeee0101-0001-0003-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2026-01-01', 50),
  ('eeee0101-0001-0003-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2026-02-01', 58),
  ('eeee0101-0001-0003-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'US-VA-584', 'barn wedding venue', '2026-03-01', 55)
ON CONFLICT (id) DO NOTHING;

-- Crestwood Farm (metro: US-VA-584)
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'wedding venue', '2025-10-01', 50),
  ('eeee0101-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'wedding venue', '2025-11-01', 46),
  ('eeee0101-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'wedding venue', '2025-12-01', 36),
  ('eeee0101-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'wedding venue', '2026-01-01', 70),
  ('eeee0101-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'wedding venue', '2026-02-01', 82),
  ('eeee0101-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'wedding venue', '2026-03-01', 90)
ON CONFLICT (id) DO NOTHING;

INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0002-0002-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'barn wedding', '2025-10-01', 45),
  ('eeee0101-0002-0002-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'barn wedding', '2025-11-01', 40),
  ('eeee0101-0002-0002-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'barn wedding', '2025-12-01', 30),
  ('eeee0101-0002-0002-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'barn wedding', '2026-01-01', 55),
  ('eeee0101-0002-0002-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'barn wedding', '2026-02-01', 62),
  ('eeee0101-0002-0002-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'barn wedding', '2026-03-01', 60)
ON CONFLICT (id) DO NOTHING;

INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0002-0003-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'outdoor wedding venue', '2025-10-01', 55),
  ('eeee0101-0002-0003-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'outdoor wedding venue', '2025-11-01', 42),
  ('eeee0101-0002-0003-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'outdoor wedding venue', '2025-12-01', 25),
  ('eeee0101-0002-0003-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'outdoor wedding venue', '2026-01-01', 48),
  ('eeee0101-0002-0003-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'outdoor wedding venue', '2026-02-01', 60),
  ('eeee0101-0002-0003-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'US-VA-584', 'outdoor wedding venue', '2026-03-01', 72)
ON CONFLICT (id) DO NOTHING;

-- The Glass House (metro: US-VA-556 — Richmond)
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2025-10-01', 60),
  ('eeee0101-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2025-11-01', 55),
  ('eeee0101-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2025-12-01', 42),
  ('eeee0101-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2026-01-01', 78),
  ('eeee0101-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2026-02-01', 88),
  ('eeee0101-0003-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding venue', '2026-03-01', 85)
ON CONFLICT (id) DO NOTHING;

INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0003-0002-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'modern wedding venue', '2025-10-01', 35),
  ('eeee0101-0003-0002-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'modern wedding venue', '2025-11-01', 32),
  ('eeee0101-0003-0002-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'modern wedding venue', '2025-12-01', 25),
  ('eeee0101-0003-0002-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'modern wedding venue', '2026-01-01', 45),
  ('eeee0101-0003-0002-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'modern wedding venue', '2026-02-01', 52),
  ('eeee0101-0003-0002-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'modern wedding venue', '2026-03-01', 48)
ON CONFLICT (id) DO NOTHING;

INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0003-0003-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding photographer richmond', '2025-10-01', 48),
  ('eeee0101-0003-0003-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding photographer richmond', '2025-11-01', 40),
  ('eeee0101-0003-0003-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding photographer richmond', '2025-12-01', 30),
  ('eeee0101-0003-0003-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding photographer richmond', '2026-01-01', 55),
  ('eeee0101-0003-0003-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding photographer richmond', '2026-02-01', 62),
  ('eeee0101-0003-0003-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'US-VA-556', 'wedding photographer richmond', '2026-03-01', 58)
ON CONFLICT (id) DO NOTHING;

-- Rose Hill Gardens (metro: US-DC-511 — DC area)
INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'wedding venue', '2025-10-01', 65),
  ('eeee0101-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'wedding venue', '2025-11-01', 58),
  ('eeee0101-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'wedding venue', '2025-12-01', 45),
  ('eeee0101-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'wedding venue', '2026-01-01', 80),
  ('eeee0101-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'wedding venue', '2026-02-01', 90),
  ('eeee0101-0004-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'wedding venue', '2026-03-01', 88)
ON CONFLICT (id) DO NOTHING;

INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0004-0002-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'garden wedding venue', '2025-10-01', 52),
  ('eeee0101-0004-0002-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'garden wedding venue', '2025-11-01', 40),
  ('eeee0101-0004-0002-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'garden wedding venue', '2025-12-01', 28),
  ('eeee0101-0004-0002-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'garden wedding venue', '2026-01-01', 48),
  ('eeee0101-0004-0002-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'garden wedding venue', '2026-02-01', 60),
  ('eeee0101-0004-0002-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'garden wedding venue', '2026-03-01', 75)
ON CONFLICT (id) DO NOTHING;

INSERT INTO search_trends (id, venue_id, metro, term, week, interest) VALUES
  ('eeee0101-0004-0003-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'engagement ring', '2025-10-01', 62),
  ('eeee0101-0004-0003-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'engagement ring', '2025-11-01', 82),
  ('eeee0101-0004-0003-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'engagement ring', '2025-12-01', 100),
  ('eeee0101-0004-0003-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'engagement ring', '2026-01-01', 72),
  ('eeee0101-0004-0003-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'engagement ring', '2026-02-01', 85),
  ('eeee0101-0004-0003-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'US-DC-511', 'engagement ring', '2026-03-01', 65)
ON CONFLICT (id) DO NOTHING;
-- Total: 72 rows (12 blocks x 6 rows)


-- ============================================================
-- 2. WEATHER DATA — 6 months of monthly averages, all 4 venues
-- ============================================================
-- All Virginia, slightly different microclimates
-- Columns: id, venue_id, date, high_temp, low_temp, precipitation, conditions, source

-- Rixey Manor (Culpeper — slightly cooler, more rural)
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('eeee0201-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '2025-10-01', 67, 44, 3.2, 'Partly Cloudy', 'noaa_historical'),
  ('eeee0201-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '2025-11-01', 54, 34, 3.8, 'Cloudy', 'noaa_historical'),
  ('eeee0201-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '2025-12-01', 41, 26, 2.9, 'Clear', 'noaa_historical'),
  ('eeee0201-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '2026-01-01', 39, 23, 3.1, 'Partly Cloudy', 'noaa_historical'),
  ('eeee0201-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '2026-02-01', 44, 27, 2.8, 'Clear', 'noaa_historical'),
  ('eeee0201-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '2026-03-01', 54, 34, 3.5, 'Partly Cloudy', 'noaa_historical')
ON CONFLICT (id) DO NOTHING;

-- Crestwood Farm (Charlottesville — similar to Rixey, slightly warmer valley)
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('eeee0201-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', '2025-10-01', 69, 46, 3.0, 'Partly Cloudy', 'noaa_historical'),
  ('eeee0201-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', '2025-11-01', 56, 36, 3.5, 'Rain', 'noaa_historical'),
  ('eeee0201-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '2025-12-01', 43, 28, 2.7, 'Cloudy', 'noaa_historical'),
  ('eeee0201-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', '2026-01-01', 41, 25, 3.0, 'Clear', 'noaa_historical'),
  ('eeee0201-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', '2026-02-01', 46, 29, 2.6, 'Partly Cloudy', 'noaa_historical'),
  ('eeee0201-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', '2026-03-01', 56, 36, 3.4, 'Clear', 'noaa_historical')
ON CONFLICT (id) DO NOTHING;

-- The Glass House (Richmond — slightly warmer, urban heat island)
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('eeee0201-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', '2025-10-01', 71, 48, 3.4, 'Clear', 'noaa_historical'),
  ('eeee0201-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', '2025-11-01', 58, 38, 3.2, 'Partly Cloudy', 'noaa_historical'),
  ('eeee0201-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '2025-12-01', 45, 30, 3.0, 'Cloudy', 'noaa_historical'),
  ('eeee0201-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', '2026-01-01', 43, 28, 3.3, 'Clear', 'noaa_historical'),
  ('eeee0201-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', '2026-02-01', 48, 31, 2.9, 'Partly Cloudy', 'noaa_historical'),
  ('eeee0201-0003-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', '2026-03-01', 58, 38, 3.6, 'Partly Cloudy', 'noaa_historical')
ON CONFLICT (id) DO NOTHING;

-- Rose Hill Gardens (Leesburg — DC suburbs, moderate)
INSERT INTO weather_data (id, venue_id, date, high_temp, low_temp, precipitation, conditions, source) VALUES
  ('eeee0201-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', '2025-10-01', 68, 46, 3.3, 'Clear', 'noaa_historical'),
  ('eeee0201-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', '2025-11-01', 55, 36, 3.6, 'Cloudy', 'noaa_historical'),
  ('eeee0201-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', '2025-12-01', 42, 28, 3.0, 'Partly Cloudy', 'noaa_historical'),
  ('eeee0201-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', '2026-01-01', 40, 25, 3.2, 'Clear', 'noaa_historical'),
  ('eeee0201-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', '2026-02-01', 45, 28, 2.7, 'Partly Cloudy', 'noaa_historical'),
  ('eeee0201-0004-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', '2026-03-01', 55, 35, 3.4, 'Rain', 'noaa_historical')
ON CONFLICT (id) DO NOTHING;
-- Total: 24 rows


-- ============================================================
-- 3. ECONOMIC INDICATORS — 6 months of FRED data (national)
-- ============================================================
-- Columns: id, indicator_name, date, value, source
-- Shows slight uncertainty trending up, then stabilizing

INSERT INTO economic_indicators (id, indicator_name, date, value, source) VALUES
  -- consumer_sentiment (University of Michigan, 0-100+ scale)
  ('eeee0301-0000-0001-0001-000000000001', 'consumer_sentiment', '2025-10-01', 69.4, 'fred'),
  ('eeee0301-0000-0001-0001-000000000002', 'consumer_sentiment', '2025-11-01', 71.8, 'fred'),
  ('eeee0301-0000-0001-0001-000000000003', 'consumer_sentiment', '2025-12-01', 73.2, 'fred'),
  ('eeee0301-0000-0001-0001-000000000004', 'consumer_sentiment', '2026-01-01', 72.0, 'fred'),
  ('eeee0301-0000-0001-0001-000000000005', 'consumer_sentiment', '2026-02-01', 74.1, 'fred'),
  ('eeee0301-0000-0001-0001-000000000006', 'consumer_sentiment', '2026-03-01', 75.3, 'fred'),

  -- conference_board (Consumer Confidence Index, ~100 baseline)
  ('eeee0301-0000-0002-0001-000000000001', 'conference_board', '2025-10-01', 102.5, 'fred'),
  ('eeee0301-0000-0002-0001-000000000002', 'conference_board', '2025-11-01', 101.2, 'fred'),
  ('eeee0301-0000-0002-0001-000000000003', 'conference_board', '2025-12-01', 104.8, 'fred'),
  ('eeee0301-0000-0002-0001-000000000004', 'conference_board', '2026-01-01', 105.3, 'fred'),
  ('eeee0301-0000-0002-0001-000000000005', 'conference_board', '2026-02-01', 106.9, 'fred'),
  ('eeee0301-0000-0002-0001-000000000006', 'conference_board', '2026-03-01', 108.1, 'fred'),

  -- cpi_services (CPI for services, year-over-year %)
  ('eeee0301-0000-0003-0001-000000000001', 'cpi_services', '2025-10-01', 4.8, 'fred'),
  ('eeee0301-0000-0003-0001-000000000002', 'cpi_services', '2025-11-01', 4.6, 'fred'),
  ('eeee0301-0000-0003-0001-000000000003', 'cpi_services', '2025-12-01', 4.5, 'fred'),
  ('eeee0301-0000-0003-0001-000000000004', 'cpi_services', '2026-01-01', 4.3, 'fred'),
  ('eeee0301-0000-0003-0001-000000000005', 'cpi_services', '2026-02-01', 4.1, 'fred'),
  ('eeee0301-0000-0003-0001-000000000006', 'cpi_services', '2026-03-01', 3.9, 'fred'),

  -- policy_uncertainty (Economic Policy Uncertainty Index, ~100 baseline)
  ('eeee0301-0000-0004-0001-000000000001', 'policy_uncertainty', '2025-10-01', 112, 'fred'),
  ('eeee0301-0000-0004-0001-000000000002', 'policy_uncertainty', '2025-11-01', 125, 'fred'),
  ('eeee0301-0000-0004-0001-000000000003', 'policy_uncertainty', '2025-12-01', 118, 'fred'),
  ('eeee0301-0000-0004-0001-000000000004', 'policy_uncertainty', '2026-01-01', 130, 'fred'),
  ('eeee0301-0000-0004-0001-000000000005', 'policy_uncertainty', '2026-02-01', 122, 'fred'),
  ('eeee0301-0000-0004-0001-000000000006', 'policy_uncertainty', '2026-03-01', 115, 'fred')
ON CONFLICT (id) DO NOTHING;
-- Total: 24 rows


-- ============================================================
-- 4. ANOMALY ALERTS — realistic alerts over 6 months
-- ============================================================
-- Columns: id, venue_id, alert_type, metric_name, current_value, baseline_value,
--          change_percent, severity, ai_explanation, causes, acknowledged, acknowledged_by

-- Oct 2025: Rose Hill sees unusual inquiry dip
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, acknowledged_by, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'decline', 'inquiry_volume', 1, 4, -75, 'warning',
   'Inquiry volume dropped significantly in October. Only 1 new inquiry vs your typical 4 per month. This coincides with the end of peak wedding season when browsing naturally slows.',
   '[{"cause": "Seasonal slowdown — October is post-peak for garden venues", "likelihood": "high", "action": "Normal pattern, but consider a late-fall social media push"},{"cause": "Listing may have fallen in search ranking", "likelihood": "medium", "action": "Check your WeddingWire and Knot listing positions"}]',
   true, '33333333-3333-3333-3333-333333333304', '2025-10-18 10:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Nov 2025: Crestwood booking rate drops
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'decline', 'booking_rate', 0.10, 0.30, -66, 'warning',
   'Your inquiry-to-booking conversion rate fell from 30% to 10% in November. You received a healthy number of inquiries but only converted one. Two toured couples cited budget concerns.',
   '[{"cause": "Economic uncertainty may be making couples more price-sensitive", "likelihood": "high", "action": "Consider offering a winter booking incentive"},{"cause": "Competitors may be running promotions", "likelihood": "medium", "action": "Check competitor pricing and packages"}]',
   true, NULL, '2025-11-22 14:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Dec 2025: Rixey Manor response time warning (holiday)
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, acknowledged_by, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'spike', 'avg_response_time', 8.5, 2.1, 305, 'critical',
   'Average response time jumped to 8.5 hours over the holiday period, up from your usual 2.1 hours. Two inquiries from December 22-26 went more than 12 hours without a reply. Fast response time is your strongest competitive advantage — this matters.',
   '[{"cause": "Holiday staffing — Sarah was on PTO Dec 23-27", "likelihood": "high", "action": "Set up auto-send for holidays or assign backup coverage"},{"cause": "Email sync may have been delayed", "likelihood": "low", "action": "Check Gmail sync status"}]',
   true, '33333333-3333-3333-3333-333333333301', '2025-12-28 09:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Jan 2026: Glass House inquiry volume surge
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, acknowledged_by, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'surge', 'inquiry_volume', 12, 6, 100, 'info',
   'January inquiry volume doubled compared to your 6-month average. This is a positive signal aligned with the post-holiday engagement surge. Wedding venue searches in Richmond are up 86% from December.',
   '[{"cause": "Holiday engagement surge — Christmas and NYE proposals driving January browsing", "likelihood": "high", "action": "Ensure tour availability is open for the next 3 weekends"},{"cause": "Google Ads spend increase took effect", "likelihood": "medium", "action": "Monitor cost-per-inquiry to ensure efficiency"}]',
   true, '33333333-3333-3333-3333-333333333303', '2026-01-15 08:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Jan 2026: Rixey Manor inquiry surge too
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, acknowledged_by, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'surge', 'inquiry_volume', 8, 4, 100, 'info',
   'Strong January for Rixey Manor. 8 new inquiries — double your typical volume. The holiday proposal wave is hitting and your listing photos are performing well.',
   '[{"cause": "Post-holiday engagement wave", "likelihood": "high", "action": "Prioritize tour scheduling for these warm leads"},{"cause": "Updated listing photos from November showing fall colors", "likelihood": "medium", "action": "Continue seasonal photo rotation"}]',
   true, '33333333-3333-3333-3333-333333333301', '2026-01-18 10:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Feb 2026: Rose Hill review sentiment dip
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'decline', 'review_sentiment', 3.8, 4.6, -17, 'warning',
   'Your average review score dropped from 4.6 to 3.8 this month after two below-average reviews on The Knot. One mentioned parking difficulties, the other noted limited restroom facilities. These are fixable operational issues, not venue quality problems.',
   '[{"cause": "Parking lot was muddy during winter rain events", "likelihood": "high", "action": "Add gravel to the overflow parking area before spring"},{"cause": "Portable restrooms for large events felt inadequate", "likelihood": "high", "action": "Consider upgrading to luxury restroom trailers for 150+ guest events"}]',
   false, '2026-02-12 11:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Feb 2026: Crestwood Farm — referrals spiking
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, acknowledged_by, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000007', '22222222-2222-2222-2222-222222222202', 'surge', 'referral_inquiries', 5, 2, 150, 'info',
   'Referral inquiries up 150% this month. Five of your seven February inquiries mentioned they were referred by a past couple. Your word-of-mouth game is strong — this is your most cost-effective source.',
   '[{"cause": "Three fall weddings from your busiest season are now in post-event review phase", "likelihood": "high", "action": "Send a thank-you note and ask these couples to leave Google reviews"},{"cause": "Instagram reels from those weddings are circulating", "likelihood": "medium", "action": "Repost the most-shared vendor content and tag the couples"}]',
   true, '33333333-3333-3333-3333-333333333302', '2026-02-20 09:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Mar 2026: Glass House tour conversion drop
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000008', '22222222-2222-2222-2222-222222222203', 'decline', 'tour_conversion', 0.25, 0.50, -50, 'critical',
   'Tour conversion rate dropped from 50% to 25% this period. 3 out of 4 toured couples did not book. This warrants investigation — your typical close rate is among the highest in the portfolio.',
   '[{"cause": "Pricing may be above market for current lead profiles", "likelihood": "medium", "action": "Review proposal pricing vs competitor rates"},{"cause": "Tour experience may need refreshing", "likelihood": "medium", "action": "Shadow the next tour and check for gaps in the walkthrough"},{"cause": "Lead quality from Google Ads may have shifted", "likelihood": "low", "action": "Check which sources the non-converting leads came from"}]',
   false, '2026-03-18 14:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Mar 2026: Rixey Manor inquiry volume surge (spring)
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000009', '22222222-2222-2222-2222-222222222201', 'surge', 'inquiry_volume', 6, 3, 100, 'info',
   'Inquiry volume doubled this week compared to the prior week. This is a positive signal — spring is peak browsing season and your search visibility appears strong. Wedding venue searches in your metro are up 22% in the last two weeks.',
   '[{"cause": "Seasonal spring engagement surge", "likelihood": "high", "action": "Ensure all inquiries get a response within 2 hours"},{"cause": "Increased search visibility from trending terms", "likelihood": "medium", "action": "Monitor The Knot and Google listing performance"}]',
   false, '2026-03-24 08:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Mar 2026: Rose Hill — no response to hot lead
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000010', '22222222-2222-2222-2222-222222222204', 'spike', 'response_gap', 48, 3, 1500, 'critical',
   'A hot inquiry from March 25 has gone 48 hours without any response. This lead came from Google and has a 93 heat score. Every hour of delay decreases conversion probability by roughly 8%. This needs immediate attention.',
   '[{"cause": "Inquiry may have been missed in inbox", "likelihood": "high", "action": "Respond immediately — this lead is actively shopping"},{"cause": "Auto-send is disabled for Rose Hill", "likelihood": "high", "action": "Consider enabling auto-send for at least an acknowledgment email"}]',
   false, '2026-03-27 10:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Nov 2025: Glass House strong month
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, acknowledged_by, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000011', '22222222-2222-2222-2222-222222222203', 'surge', 'revenue_booked', 38500, 18000, 114, 'info',
   'Outstanding November. You closed two bookings totaling $38,500 in booked revenue — more than double your monthly average. Both leads came from The Knot and had short tour-to-booking cycles.',
   '[{"cause": "Strong lead quality from The Knot premium listing", "likelihood": "high", "action": "Maintain premium listing investment"},{"cause": "November couples may be more decisive — shorter engagement periods", "likelihood": "medium", "action": "Track engagement length as a lead quality signal"}]',
   true, '33333333-3333-3333-3333-333333333303', '2025-11-28 09:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Dec 2025: Crestwood slow season
INSERT INTO anomaly_alerts (id, venue_id, alert_type, metric_name, current_value, baseline_value, change_percent, severity, ai_explanation, causes, acknowledged, acknowledged_by, created_at) VALUES
  ('eeee0401-0000-0000-0001-000000000012', '22222222-2222-2222-2222-222222222202', 'decline', 'inquiry_volume', 1, 3, -66, 'info',
   'December is historically the slowest month for barn venues in Virginia. Only 1 inquiry this month, which is within normal seasonal range. Focus on content creation and spring prep rather than worrying about volume.',
   '[{"cause": "Normal seasonal dip — couples browse, not inquire, in December", "likelihood": "high", "action": "Use this quiet month for spring marketing prep and photo shoots"}]',
   true, '33333333-3333-3333-3333-333333333302', '2025-12-20 10:00:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 12 alerts


-- ============================================================
-- 5. AI BRIEFINGS — weekly for Rixey + monthly for all venues
-- ============================================================
-- Columns: id, venue_id, briefing_type, content (jsonb), delivered_via, delivered_at, created_at

-- ---- RIXEY MANOR WEEKLY BRIEFINGS (4 recent weeks) ----
INSERT INTO ai_briefings (id, venue_id, briefing_type, content, delivered_via, delivered_at, created_at) VALUES
  ('eeee0501-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'weekly',
   '{"summary": "Quiet week at Rixey Manor with just 1 new inquiry. The November proposal couple (Chloe & Ryan) signed their contract — $16,000 booked for May 2026. Response times were excellent at 1.8 hours average.", "highlights": ["Chloe & Ryan booked (May 2026, $16,000)", "Response time average: 1.8 hours", "Instagram engagement up 15% on fall photo carousel"], "recommendations": ["Send welcome packet to Chloe & Ryan within 48 hours", "Reshare the fall carousel — it performed 3x your average reach", "December is slow — use downtime to update knowledge base answers"], "metrics": {"inquiries": 1, "tours": 2, "bookings": 1, "revenue": 16000}}',
   'email', '2025-12-05 08:00:00+00', '2025-12-05 08:00:00+00'),

  ('eeee0501-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'weekly',
   '{"summary": "Holiday week — response times spiked to 8+ hours while Sarah was on PTO. Two inquiries came in Dec 23-24 and sat too long. The engagement ring search surge suggests a big January ahead.", "highlights": ["Response time spiked to 8.5 hours (holiday coverage gap)", "2 inquiries received during Dec 23-26 PTO window", "Engagement ring searches hit seasonal peak — January wave incoming"], "recommendations": ["Set up auto-acknowledgment for holiday periods", "Follow up immediately on the two delayed inquiries", "Prepare tour availability for January — expect 2-3x normal volume"], "metrics": {"inquiries": 2, "tours": 0, "bookings": 0, "revenue": 0}}',
   'email', '2025-12-29 08:00:00+00', '2025-12-29 08:00:00+00'),

  ('eeee0501-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'weekly',
   '{"summary": "January started strong with 3 new inquiries in the first two weeks — all from newly engaged couples. Wedding venue searches are up 72% from December. Tour slots filling fast for the next three weekends.", "highlights": ["3 new inquiries in first two weeks of January", "All 3 leads mention recent engagement (holiday proposals)", "Wedding venue searches up 72% in your metro", "Tour slots: 2 remaining for Jan 18-19 weekend"], "recommendations": ["Prioritize tour scheduling — these leads are hot and shopping actively", "Update The Knot photos with winter property shots", "Send the January special to the delayed December inquiries", "Block additional tour slots for the next 4 weekends"], "metrics": {"inquiries": 3, "tours": 1, "bookings": 0, "revenue": 0}}',
   'email', '2026-01-13 08:00:00+00', '2026-01-13 08:00:00+00'),

  ('eeee0501-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'weekly',
   '{"summary": "Strong week for Rixey Manor. 2 new inquiries came in (both hot), and the proposal for the November wedding is still pending. Wedding venue searches in your metro are up 22% — this is peak browsing season.", "highlights": ["2 new hot inquiries this week", "November proposal still pending — needs follow-up", "Wedding venue searches up 22% in Culpeper/Charlottesville", "Beautiful touring weather ahead (highs 68-73)"], "recommendations": ["Follow up with the March 26 inquiry (no response yet)", "Offer weekend tour slots while weather is perfect", "Refresh spring photos on The Knot — searches are peaking", "Send November proposal couple a gentle check-in"], "metrics": {"inquiries": 2, "tours": 1, "bookings": 0, "revenue": 0}}',
   'email', '2026-03-27 08:00:00+00', '2026-03-27 08:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ---- RIXEY MANOR MONTHLY BRIEFINGS (6 months) ----
INSERT INTO ai_briefings (id, venue_id, briefing_type, content, delivered_via, delivered_at, created_at) VALUES
  ('eeee0502-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'monthly',
   '{"summary": "October was a solid month with 3 inquiries, 2 tours, and 1 booking ($17,500 for Sep 2026). The Knot continues to be your strongest source. Engagement ring searches are climbing — holiday proposal wave is building.", "highlights": ["1 booking: $17,500 (Sep 2026 wedding)", "Inquiry-to-tour rate: 67%", "Average response time: 2.1 hours (excellent)", "Google listing impressions up 12%"], "recommendations": ["Prepare for the January inquiry surge — clear tour availability", "Update fall photos on all listing platforms", "Consider a New Year promotion for winter inquiries"], "metrics": {"inquiries": 3, "tours": 2, "bookings": 1, "revenue": 17500}}',
   'email', '2025-11-01 08:00:00+00', '2025-11-01 08:00:00+00'),

  ('eeee0502-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'monthly',
   '{"summary": "November brought 4 inquiries and 2 bookings totaling $26,300 in new revenue. Response times stayed under 2 hours. Your referral pipeline is producing — both bookings came from past couple referrals.", "highlights": ["2 bookings: $11,500 + $14,800 = $26,300", "4 inquiries from diverse sources", "Both bookings were referrals (zero acquisition cost)", "Referral conversion rate: 100%"], "recommendations": ["Thank the referring couples with a handwritten note", "Start a formal referral incentive program", "Engagement ring peak is here — be ready for December inquiries"], "metrics": {"inquiries": 4, "tours": 3, "bookings": 2, "revenue": 26300}}',
   'email', '2025-12-01 08:00:00+00', '2025-12-01 08:00:00+00'),

  ('eeee0502-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'monthly',
   '{"summary": "December was quiet (2 inquiries) but that is seasonal and expected. The holiday response time gap is the main concern — 8+ hours during PTO. The engagement ring search peak was the highest since tracking began. Brace for a big January.", "highlights": ["2 inquiries (seasonal norm for December)", "Response time gap during Dec 23-27 PTO", "Engagement ring searches hit 95 (all-time high in your metro)", "No bookings — normal for off-season"], "recommendations": ["Solve the holiday coverage gap before next year", "January will be your busiest inquiry month — prepare now", "Pre-schedule social media content for the first two weeks of January"], "metrics": {"inquiries": 2, "tours": 1, "bookings": 0, "revenue": 0}}',
   'email', '2026-01-01 08:00:00+00', '2026-01-01 08:00:00+00'),

  ('eeee0502-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'monthly',
   '{"summary": "January delivered as predicted — 8 inquiries, your highest volume month. 5 tours completed, 2 proposals sent. The holiday engagement wave hit hard and your response times bounced back to 1.9 hours. Strong pipeline entering February.", "highlights": ["8 new inquiries (100% increase from average)", "5 tours completed", "2 proposals sent ($16,000 + $13,000)", "Response time back to 1.9 hours average", "Wedding venue searches up 72%"], "recommendations": ["Follow up on both pending proposals within 48 hours", "Book additional tour slots for February — momentum is strong", "The Knot produced 3 of 8 inquiries — maintain that listing investment", "Start tracking which tour day/time converts best"], "metrics": {"inquiries": 8, "tours": 5, "bookings": 0, "revenue": 0}}',
   'email', '2026-02-01 08:00:00+00', '2026-02-01 08:00:00+00'),

  ('eeee0502-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'monthly',
   '{"summary": "February saw 4 inquiries with 3 tours and 1 booking ($14,800 for Oct 2026). The January proposal converted — Chloe & Ryan signed. Total pipeline value is now $43,800 across 3 proposals pending. Instagram is emerging as a real source.", "highlights": ["1 booking: $14,800 (Oct 2026)", "January proposal converted (Chloe & Ryan)", "Total pending pipeline: $43,800", "Instagram produced 2 inquiries for the first time"], "recommendations": ["Double down on Instagram — reels are driving real traffic", "Send pricing adjustments for peak dates before they fill", "Refresh your Google Business Profile with February content", "Consider raising prices $500 for peak season — demand supports it"], "metrics": {"inquiries": 4, "tours": 3, "bookings": 1, "revenue": 14800}}',
   'email', '2026-03-01 08:00:00+00', '2026-03-01 08:00:00+00'),

  ('eeee0502-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'monthly',
   '{"summary": "March is shaping up to be another strong month. 6 inquiries so far with 2 weeks to go. Two hot leads need immediate attention (one has been unresponded for 48 hours). Wedding venue searches peaked at 95 — the highest since tracking began. Spring touring weather is perfect.", "highlights": ["6 inquiries in first 3.5 weeks", "2 hot leads scoring 90+ need responses", "Wedding venue searches at 95 (all-time high)", "Perfect touring weather: highs 66-73 this week"], "recommendations": ["URGENT: Respond to the March 26 inquiry immediately", "Offer same-week tour slots — weather is ideal", "Consider enabling auto-send for initial acknowledgments", "Pipeline update: $43,800 pending + 2 hot leads in progress"], "metrics": {"inquiries": 6, "tours": 2, "bookings": 0, "revenue": 0}}',
   'email', '2026-03-28 08:00:00+00', '2026-03-28 08:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ---- CRESTWOOD FARM MONTHLY BRIEFINGS (6 months) ----
INSERT INTO ai_briefings (id, venue_id, briefing_type, content, delivered_via, delivered_at, created_at) VALUES
  ('eeee0502-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'monthly',
   '{"summary": "October saw 2 inquiries and 1 tour for Crestwood Farm. The barn renovation photos are performing well on Instagram. Booking rate held steady at 33%.", "highlights": ["2 inquiries, 1 tour, 0 bookings", "Barn renovation photos trending on Instagram", "Referral from summer wedding came in"], "recommendations": ["Post behind-the-scenes renovation content", "Follow up with toured couple within 3 days", "Prepare winter pricing package"], "metrics": {"inquiries": 2, "tours": 1, "bookings": 0, "revenue": 0}}',
   'email', '2025-11-01 08:00:00+00', '2025-11-01 08:00:00+00'),

  ('eeee0502-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'monthly',
   '{"summary": "November was challenging with a drop in booking rate to 10%. Budget concerns were cited by two toured couples. The economic uncertainty index ticked up, which may be making couples more price-sensitive.", "highlights": ["3 inquiries, 2 tours, 0 bookings", "Two couples cited budget as concern", "Economic uncertainty index up 12%"], "recommendations": ["Consider offering a winter booking incentive ($500 off for Dec-Feb bookings)", "Highlight your BYOB flexibility — it is your strongest value proposition", "Create a budget comparison showing total cost vs in-house venues"], "metrics": {"inquiries": 3, "tours": 2, "bookings": 0, "revenue": 0}}',
   'email', '2025-12-01 08:00:00+00', '2025-12-01 08:00:00+00'),

  ('eeee0502-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'monthly',
   '{"summary": "December was the slowest month as expected — 1 inquiry. This is normal seasonal behavior for a barn venue. Use this time to prepare for the January surge.", "highlights": ["1 inquiry (seasonal norm)", "Barn wedding searches dropped to 30", "Engagement ring searches peaked — January wave building"], "recommendations": ["Use downtime for spring marketing prep", "Schedule professional spring photos for March", "Update vendor recommendations list for 2026 season"], "metrics": {"inquiries": 1, "tours": 0, "bookings": 0, "revenue": 0}}',
   'email', '2026-01-01 08:00:00+00', '2026-01-01 08:00:00+00'),

  ('eeee0502-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'monthly',
   '{"summary": "January bounce-back — 5 inquiries and 1 booking ($8,800 for June 2026). The winter incentive worked: the booked couple specifically mentioned the discount. Barn wedding searches are climbing again.", "highlights": ["5 inquiries (5x December volume)", "1 booking: $8,800 (June 2026)", "Winter incentive drove the booking", "Barn wedding searches up 83% from Dec"], "recommendations": ["Continue the winter incentive through February", "Schedule tours for all 4 pending leads", "Post the first meadow photo of the season when spring blooms start"], "metrics": {"inquiries": 5, "tours": 3, "bookings": 1, "revenue": 8800}}',
   'email', '2026-02-01 08:00:00+00', '2026-02-01 08:00:00+00'),

  ('eeee0502-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'monthly',
   '{"summary": "February was your best referral month ever — 5 of 7 inquiries were word-of-mouth. 1 more booking ($10,200 for Sep 2026). Your past couples are your best marketing channel and it costs you nothing.", "highlights": ["7 inquiries (5 referrals)", "1 booking: $10,200 (Sep 2026)", "Referral rate: 71% of all inquiries", "Zero marketing spend on those 5 leads"], "recommendations": ["Launch a formal referral thank-you program", "Ask your fall wedding couples for Google reviews", "Referrals are converting faster — track days-to-book for this segment"], "metrics": {"inquiries": 7, "tours": 4, "bookings": 1, "revenue": 10200}}',
   'email', '2026-03-01 08:00:00+00', '2026-03-01 08:00:00+00'),

  ('eeee0502-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'monthly',
   '{"summary": "March has been steady with 3 inquiries and a completed tour so far. One hot lead from The Knot (90 guests, fall wedding) is very engaged. Outdoor wedding venue searches are surging — your spring photos will be critical.", "highlights": ["3 inquiries in first 3 weeks", "1 hot lead (heat score 88)", "Outdoor venue searches up 44% month-over-month", "Spring touring season is here"], "recommendations": ["Respond to the March 22 hot lead within 24 hours", "Schedule the spring photo shoot this weekend", "Update your WeddingWire listing with fresh content", "Consider raising your base price $250 — demand warrants it"], "metrics": {"inquiries": 3, "tours": 1, "bookings": 0, "revenue": 0}}',
   'email', '2026-03-28 08:00:00+00', '2026-03-28 08:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ---- THE GLASS HOUSE MONTHLY BRIEFINGS (6 months) ----
INSERT INTO ai_briefings (id, venue_id, briefing_type, content, delivered_via, delivered_at, created_at) VALUES
  ('eeee0502-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'monthly',
   '{"summary": "October was solid with 5 inquiries, 3 tours, and 1 booking ($18,500). Google Ads is your strongest performer with a 3:1 ROI. The modern venue aesthetic is trending well in Richmond searches.", "highlights": ["5 inquiries, 3 tours, 1 booking", "Google Ads ROI: 3.2x", "Modern wedding venue searches steady", "Average booking value: $18,500"], "recommendations": ["Increase Google Ads budget for Q1 — your ROI supports it", "Feature more behind-the-scenes content showing your in-house catering", "Follow up with the 2 toured-but-not-booked couples"], "metrics": {"inquiries": 5, "tours": 3, "bookings": 1, "revenue": 18500}}',
   'email', '2025-11-01 08:00:00+00', '2025-11-01 08:00:00+00'),

  ('eeee0502-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'monthly',
   '{"summary": "Outstanding November. 6 inquiries and 2 bookings totaling $38,500 — your best revenue month in 6 months. Both from The Knot with short conversion cycles. In-house catering was mentioned positively in both booking conversations.", "highlights": ["2 bookings: $20,000 + $18,500 = $38,500", "The Knot drove both bookings", "Average days-to-book: 28 (fast)", "In-house catering praised as differentiator"], "recommendations": ["Maintain The Knot premium listing — it is printing money", "Feature catering menu highlights in your next social post", "Consider a winter tasting event for pending proposals"], "metrics": {"inquiries": 6, "tours": 4, "bookings": 2, "revenue": 38500}}',
   'email', '2025-12-01 08:00:00+00', '2025-12-01 08:00:00+00'),

  ('eeee0502-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'monthly',
   '{"summary": "December saw 3 inquiries and 1 booking ($15,800 for Aug 2026). Holiday engagement proposals are already converting into venue inquiries faster than last year. Your Instagram Reels featuring the space at night are performing very well.", "highlights": ["3 inquiries, 2 tours, 1 booking ($15,800)", "Instagram Reels: 15K views on venue night tour", "Inquiry quality high — all requesting 175+ guest events"], "recommendations": ["Double down on Instagram Reels — your night aesthetic is unique", "Prepare January calendar with extra tour slots", "Create a New Year proposal special for couples who just got engaged"], "metrics": {"inquiries": 3, "tours": 2, "bookings": 1, "revenue": 15800}}',
   'email', '2026-01-01 08:00:00+00', '2026-01-01 08:00:00+00'),

  ('eeee0502-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'monthly',
   '{"summary": "January was massive — 12 inquiries (your highest ever), 6 tours, and 2 bookings totaling $41,000. The post-holiday surge exceeded all projections. Wedding venue searches in Richmond hit 78, up 86% from December.", "highlights": ["12 inquiries (all-time monthly record)", "6 tours completed", "2 bookings: $22,500 + $18,500 = $41,000", "Wedding venue searches at 78 (86% increase)"], "recommendations": ["You are at capacity for weekend tours — consider Thursday evening slots", "Pipeline is strong: 4 proposals pending ($68,000 potential)", "Google Ads CPI increased — monitor for efficiency", "Start waitlisting popular dates for fall 2026"], "metrics": {"inquiries": 12, "tours": 6, "bookings": 2, "revenue": 41000}}',
   'email', '2026-02-01 08:00:00+00', '2026-02-01 08:00:00+00'),

  ('eeee0502-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'monthly',
   '{"summary": "February moderated to 7 inquiries with 4 tours and 1 booking. Tour conversion rate slipped to 25% — down from your usual 50%. Two couples that toured did not book, citing pricing. Worth monitoring but not alarming yet.", "highlights": ["7 inquiries, 4 tours, 1 booking ($16,500)", "Tour conversion dropped to 25%", "2 non-converters cited pricing", "Instagram continues strong — 8K average reel views"], "recommendations": ["Audit tour experience — are you communicating value well?", "Consider a \"Book by March 31\" promotion for pending leads", "Review pricing vs Richmond competitor venues", "Track which tour guide is doing which walkthroughs"], "metrics": {"inquiries": 7, "tours": 4, "bookings": 1, "revenue": 16500}}',
   'email', '2026-03-01 08:00:00+00', '2026-03-01 08:00:00+00'),

  ('eeee0502-0003-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'monthly',
   '{"summary": "March so far: 5 inquiries, 2 tours, 0 bookings. The tour conversion concern continues. One hot lead from Google (210 guests) responded positively to Nova''s initial email. CPI from Google Ads is climbing — may need budget reallocation.", "highlights": ["5 inquiries in first 3 weeks", "Tour conversion still at 25%", "1 hot lead: Priya & Nico (210 guests, Google)", "Google Ads CPI up 18% from January"], "recommendations": ["PRIORITY: Fix the tour conversion issue before it becomes a pattern", "Shadow the next 2 tours and compare notes", "Consider shifting $200/month from Google Ads to Instagram", "Send a personalized follow-up to Priya & Nico within 24 hours"], "metrics": {"inquiries": 5, "tours": 2, "bookings": 0, "revenue": 0}}',
   'email', '2026-03-28 08:00:00+00', '2026-03-28 08:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- ---- ROSE HILL GARDENS MONTHLY BRIEFINGS (6 months) ----
INSERT INTO ai_briefings (id, venue_id, briefing_type, content, delivered_via, delivered_at, created_at) VALUES
  ('eeee0502-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'monthly',
   '{"summary": "Slow October for Rose Hill — just 1 inquiry. This is typical for garden venues as the season winds down. Your Facebook ad campaign produced that lone inquiry, which is encouraging for a new channel.", "highlights": ["1 inquiry (from Facebook ad)", "Garden wedding searches dropped 23%", "Seasonal slowdown expected"], "recommendations": ["Do not panic about low volume — this is seasonal", "Use off-season to improve the property (parking, restrooms)", "Plan spring garden planting for photo-ready blooms by April"], "metrics": {"inquiries": 1, "tours": 0, "bookings": 0, "revenue": 0}}',
   'email', '2025-11-01 08:00:00+00', '2025-11-01 08:00:00+00'),

  ('eeee0502-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'monthly',
   '{"summary": "November picked up with 3 inquiries and 1 booking ($14,500 for May 2026). The booking came from The Knot and the couple specifically mentioned your garden photos. Facebook drove 1 additional inquiry.", "highlights": ["3 inquiries, 2 tours, 1 booking ($14,500)", "The Knot photo quality driving conversions", "Facebook as emerging channel (2nd month in a row)"], "recommendations": ["Invest in spring garden photography — it is converting", "Continue Facebook ads at current budget", "Follow up with the 2nd toured couple — they seemed interested"], "metrics": {"inquiries": 3, "tours": 2, "bookings": 1, "revenue": 14500}}',
   'email', '2025-12-01 08:00:00+00', '2025-12-01 08:00:00+00'),

  ('eeee0502-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'monthly',
   '{"summary": "December was quiet with 2 inquiries and no bookings. The holiday engagement ring surge in DC (interest score: 100) means your January should be strong. DC metro is a higher-demand market than the other venues.", "highlights": ["2 inquiries, 1 tour, 0 bookings", "DC engagement ring searches hit 100", "DC is highest-demand metro in portfolio"], "recommendations": ["Prepare for strong January from DC-area engaged couples", "Ensure tour availability for MLK weekend", "Consider a winter garden tour with hot cocoa to show off the off-season charm"], "metrics": {"inquiries": 2, "tours": 1, "bookings": 0, "revenue": 0}}',
   'email', '2026-01-01 08:00:00+00', '2026-01-01 08:00:00+00'),

  ('eeee0502-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'monthly',
   '{"summary": "January brought 6 inquiries — your best month since opening. 3 tours, 1 booking ($11,800 for Sep 2026). The DC metro is delivering exactly as predicted. Garden wedding searches rebounding from winter lows.", "highlights": ["6 inquiries (best month ever)", "3 tours, 1 booking ($11,800)", "DC metro producing highest lead quality", "Garden wedding searches up 71% from December"], "recommendations": ["Prioritize DC-sourced leads — they have higher booking values", "Schedule spring garden tours starting in March", "Consider upgrading to intelligence tier for deeper analytics", "Ask the booking couple for a testimonial when appropriate"], "metrics": {"inquiries": 6, "tours": 3, "bookings": 1, "revenue": 11800}}',
   'email', '2026-02-01 08:00:00+00', '2026-02-01 08:00:00+00'),

  ('eeee0502-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'monthly',
   '{"summary": "February was mixed. 4 inquiries and 2 tours but 0 bookings. The 2 negative reviews on The Knot (parking, restrooms) may be hurting conversion. Your overall review score dropped from 4.6 to 3.8 — this needs attention.", "highlights": ["4 inquiries, 2 tours, 0 bookings", "Review score dropped to 3.8 (was 4.6)", "Parking and restroom complaints in reviews", "Garden wedding searches accelerating"], "recommendations": ["PRIORITY: Address parking and restroom issues before spring", "Respond professionally to both negative reviews", "Add gravel to overflow parking before the ground softens", "Investigate luxury restroom trailer rentals for large events"], "metrics": {"inquiries": 4, "tours": 2, "bookings": 0, "revenue": 0}}',
   'email', '2026-03-01 08:00:00+00', '2026-03-01 08:00:00+00'),

  ('eeee0502-0004-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'monthly',
   '{"summary": "March is recovering with 3 inquiries so far. One hot lead from Google (90 guests) has a heat score of 93 but HAS NOT BEEN RESPONDED TO for 48+ hours. This is your most urgent issue. Garden wedding searches hit 75 — your best opportunity window is now.", "highlights": ["3 inquiries in first 3 weeks", "HOT LEAD UNRESPONDED: 48+ hours (heat score 93)", "Garden wedding searches at 75 (annual peak approaching)", "Spring blooms starting — perfect for tours"], "recommendations": ["URGENT: Respond to the March 25 inquiry NOW", "Enable auto-send for at least acknowledgment emails", "Schedule spring garden tours every weekend in April", "Your garden is about to be at its most photogenic — capitalize"], "metrics": {"inquiries": 3, "tours": 1, "bookings": 0, "revenue": 0}}',
   'email', '2026-03-28 08:00:00+00', '2026-03-28 08:00:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 28 briefings (4 weekly + 6 monthly Rixey, 6 monthly x 3 other venues)


-- ============================================================
-- 6. REVIEW LANGUAGE — extracted review phrases
-- ============================================================
-- Columns: id, venue_id, phrase, theme, sentiment_score, frequency,
--          approved_for_sage, approved_for_marketing

-- Rixey Manor (8 additional phrases beyond seed.sql)
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing, created_at) VALUES
  ('eeee0601-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'Sarah went above and beyond to make our day perfect', 'coordinator', 0.96, 3, true, true, '2025-10-15 10:00:00+00'),
  ('eeee0601-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'the sunset ceremony was a dream come true', 'experience', 0.98, 5, true, true, '2025-11-02 10:00:00+00'),
  ('eeee0601-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'having the whole estate to ourselves made it so intimate', 'exclusivity', 0.94, 4, true, true, '2025-11-20 10:00:00+00'),
  ('eeee0601-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'the getting-ready cottage was a lovely touch', 'accommodation', 0.88, 2, true, false, '2025-12-05 10:00:00+00'),
  ('eeee0601-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'our guests are still talking about the views', 'space', 0.97, 6, true, true, '2026-01-10 10:00:00+00'),
  ('eeee0601-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'way more affordable than comparable venues in the area', 'value', 0.82, 3, true, false, '2026-01-22 10:00:00+00'),
  ('eeee0601-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', 'would have liked more guidance on vendor selection', 'flexibility', -0.15, 2, false, false, '2026-02-08 10:00:00+00'),
  ('eeee0601-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', 'the firepit after-party was the highlight of the night', 'experience', 0.93, 3, true, true, '2026-03-01 10:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Crestwood Farm (10 phrases)
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing, created_at) VALUES
  ('eeee0601-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'the string lights in the barn made the whole place glow', 'space', 0.95, 5, true, true, '2025-10-10 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'Jake made everything feel easy and fun', 'coordinator', 0.92, 4, true, true, '2025-10-25 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'the meadow ceremony with the mountains was unreal', 'space', 0.97, 6, true, true, '2025-11-12 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'loved that we could bring our own food truck', 'flexibility', 0.90, 3, true, true, '2025-12-01 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'our dogs roamed free and everyone loved them', 'pets', 0.93, 2, true, true, '2026-01-08 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'honestly the best value for a barn venue in Virginia', 'value', 0.85, 4, true, true, '2026-01-20 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000007', '22222222-2222-2222-2222-222222222202', 'parking was a little tight for our 140-guest wedding', 'space', -0.20, 2, false, false, '2026-02-05 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000008', '22222222-2222-2222-2222-222222222202', 'the bonfire s''mores station was an absolute hit', 'experience', 0.91, 3, true, true, '2026-02-18 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000009', '22222222-2222-2222-2222-222222222202', 'felt like a real farm wedding not a staged one', 'experience', 0.89, 4, true, true, '2026-03-05 10:00:00+00'),
  ('eeee0601-0002-0001-0001-000000000010', '22222222-2222-2222-2222-222222222202', 'the barn could use some air conditioning for summer weddings', 'space', -0.30, 3, false, false, '2026-03-15 10:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- The Glass House (10 phrases)
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing, created_at) VALUES
  ('eeee0601-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'the floor-to-ceiling windows made our photos incredible', 'space', 0.96, 7, true, true, '2025-10-05 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'in-house catering was restaurant quality', 'food_catering', 0.93, 5, true, true, '2025-10-18 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'Maya was professional and organized from day one', 'coordinator', 0.90, 4, true, true, '2025-11-08 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'the venue at night with the city skyline is stunning', 'space', 0.98, 6, true, true, '2025-12-02 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'expensive but worth every penny', 'value', 0.75, 4, true, false, '2026-01-05 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'the cocktail hour on the terrace was perfection', 'experience', 0.94, 5, true, true, '2026-01-18 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000007', '22222222-2222-2222-2222-222222222203', 'wish they offered a smaller package for intimate weddings', 'flexibility', -0.10, 2, false, false, '2026-02-10 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000008', '22222222-2222-2222-2222-222222222203', 'the bar selection and craft cocktails were amazing', 'food_catering', 0.92, 4, true, true, '2026-02-22 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000009', '22222222-2222-2222-2222-222222222203', 'modern elegance without feeling cold or sterile', 'space', 0.88, 3, true, true, '2026-03-08 10:00:00+00'),
  ('eeee0601-0003-0001-0001-000000000010', '22222222-2222-2222-2222-222222222203', 'parking garage next door was super convenient for guests', 'space', 0.80, 3, true, false, '2026-03-20 10:00:00+00')
ON CONFLICT (id) DO NOTHING;

-- Rose Hill Gardens (10 phrases)
INSERT INTO review_language (id, venue_id, phrase, theme, sentiment_score, frequency, approved_for_sage, approved_for_marketing, created_at) VALUES
  ('eeee0601-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'the garden ceremony arch with the climbing roses was everything', 'space', 0.97, 5, true, true, '2025-10-12 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'Olivia has the best energy and made us feel so welcome', 'coordinator', 0.94, 3, true, true, '2025-11-05 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'the garden in bloom was the most beautiful thing I have ever seen', 'space', 0.99, 4, true, true, '2025-11-18 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'the butterfly garden was a unique touch none of our guests expected', 'experience', 0.92, 2, true, true, '2025-12-10 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'parking was a nightmare for our larger wedding', 'space', -0.60, 3, false, false, '2026-01-15 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'the portable restrooms were not ideal for a $10K venue', 'space', -0.45, 2, false, false, '2026-02-02 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000007', '22222222-2222-2222-2222-222222222204', 'cocktail hour in the rose garden was magical', 'experience', 0.95, 4, true, true, '2026-02-15 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000008', '22222222-2222-2222-2222-222222222204', 'close to DC but feels like you are in the countryside', 'space', 0.87, 5, true, true, '2026-02-28 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000009', '22222222-2222-2222-2222-222222222204', 'the ceremony under the old oak tree was unforgettable', 'experience', 0.96, 3, true, true, '2026-03-10 10:00:00+00'),
  ('eeee0601-0004-0001-0001-000000000010', '22222222-2222-2222-2222-222222222204', 'wish they had a rain backup plan that felt less like a tent', 'flexibility', -0.25, 2, false, false, '2026-03-22 10:00:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 38 additional phrases + 12 in seed.sql = 50 phrases


-- ============================================================
-- 7. SOURCE ATTRIBUTION — lead source tracking per venue per month
-- ============================================================
-- Columns: id, venue_id, source, period_start, period_end, spend, inquiries, tours,
--          bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi

-- Rixey Manor — Top 4 sources × 6 months
INSERT INTO source_attribution (id, venue_id, source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi) VALUES
  -- The Knot (top source)
  ('eeee0701-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'the_knot', '2025-10-01', '2025-10-31', 350, 2, 1, 1, 17500, 175, 350, 0.50, 49.0),
  ('eeee0701-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'the_knot', '2025-11-01', '2025-11-30', 350, 2, 2, 1, 14800, 175, 350, 0.50, 41.3),
  ('eeee0701-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'the_knot', '2025-12-01', '2025-12-31', 350, 1, 0, 0, 0, 350, 0, 0.00, -1.0),
  ('eeee0701-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'the_knot', '2026-01-01', '2026-01-31', 350, 3, 2, 1, 16000, 117, 350, 0.33, 44.7),
  ('eeee0701-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'the_knot', '2026-02-01', '2026-02-28', 350, 1, 1, 0, 0, 350, 0, 0.00, -1.0),
  ('eeee0701-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'the_knot', '2026-03-01', '2026-03-31', 350, 2, 1, 0, 0, 175, 0, 0.00, -1.0),
  -- Google
  ('eeee0701-0001-0002-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'google', '2025-10-01', '2025-10-31', 450, 1, 1, 0, 0, 450, 0, 0.00, -1.0),
  ('eeee0701-0001-0002-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'google', '2025-11-01', '2025-11-30', 480, 1, 0, 0, 0, 480, 0, 0.00, -1.0),
  ('eeee0701-0001-0002-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'google', '2025-12-01', '2025-12-31', 500, 1, 1, 1, 17500, 500, 500, 1.00, 34.0),
  ('eeee0701-0001-0002-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'google', '2026-01-01', '2026-01-31', 500, 3, 2, 1, 17500, 167, 500, 0.33, 34.0),
  ('eeee0701-0001-0002-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'google', '2026-02-01', '2026-02-28', 600, 1, 1, 0, 0, 600, 0, 0.00, -1.0),
  ('eeee0701-0001-0002-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'google', '2026-03-01', '2026-03-31', 650, 2, 1, 0, 0, 325, 0, 0.00, -1.0),
  -- Instagram (growing)
  ('eeee0701-0001-0003-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'instagram', '2025-10-01', '2025-10-31', 150, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0001-0003-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'instagram', '2025-11-01', '2025-11-30', 175, 1, 0, 0, 0, 175, 0, 0.00, -1.0),
  ('eeee0701-0001-0003-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'instagram', '2025-12-01', '2025-12-31', 200, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0001-0003-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-01-01', '2026-01-31', 200, 1, 1, 0, 0, 200, 0, 0.00, -1.0),
  ('eeee0701-0001-0003-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-02-01', '2026-02-28', 250, 2, 1, 1, 14800, 125, 250, 0.50, 58.2),
  ('eeee0701-0001-0003-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'instagram', '2026-03-01', '2026-03-31', 300, 1, 0, 0, 0, 300, 0, 0.00, -1.0),
  -- Referral (free)
  ('eeee0701-0001-0004-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'referral', '2025-10-01', '2025-10-31', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0001-0004-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'referral', '2025-11-01', '2025-11-30', 0, 2, 2, 2, 26300, 0, 0, 1.00, 0),
  ('eeee0701-0001-0004-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'referral', '2025-12-01', '2025-12-31', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0001-0004-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'referral', '2026-01-01', '2026-01-31', 0, 1, 1, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0001-0004-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'referral', '2026-02-01', '2026-02-28', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0001-0004-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'referral', '2026-03-01', '2026-03-31', 0, 1, 0, 0, 0, 0, 0, 0.00, 0)
ON CONFLICT (id) DO NOTHING;

-- Crestwood Farm — Top 4 sources: referral, weddingwire, the_knot, google
INSERT INTO source_attribution (id, venue_id, source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi) VALUES
  -- Referral (strongest for Crestwood)
  ('eeee0701-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'referral', '2025-10-01', '2025-10-31', 0, 1, 1, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'referral', '2025-11-01', '2025-11-30', 0, 1, 1, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'referral', '2025-12-01', '2025-12-31', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'referral', '2026-01-01', '2026-01-31', 0, 2, 1, 1, 8800, 0, 0, 0.50, 0),
  ('eeee0701-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'referral', '2026-02-01', '2026-02-28', 0, 5, 3, 1, 10200, 0, 0, 0.20, 0),
  ('eeee0701-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'referral', '2026-03-01', '2026-03-31', 0, 1, 0, 0, 0, 0, 0, 0.00, 0),
  -- WeddingWire
  ('eeee0701-0002-0002-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2025-10-01', '2025-10-31', 200, 1, 0, 0, 0, 200, 0, 0.00, -1.0),
  ('eeee0701-0002-0002-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2025-11-01', '2025-11-30', 200, 1, 1, 0, 0, 200, 0, 0.00, -1.0),
  ('eeee0701-0002-0002-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2025-12-01', '2025-12-31', 200, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0002-0002-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2026-01-01', '2026-01-31', 200, 1, 1, 0, 0, 200, 0, 0.00, -1.0),
  ('eeee0701-0002-0002-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2026-02-01', '2026-02-28', 200, 1, 0, 0, 0, 200, 0, 0.00, -1.0),
  ('eeee0701-0002-0002-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2026-03-01', '2026-03-31', 200, 1, 0, 0, 0, 200, 0, 0.00, -1.0),
  -- The Knot
  ('eeee0701-0002-0003-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'the_knot', '2025-10-01', '2025-10-31', 250, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0002-0003-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'the_knot', '2025-11-01', '2025-11-30', 250, 1, 0, 0, 0, 250, 0, 0.00, -1.0),
  ('eeee0701-0002-0003-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'the_knot', '2025-12-01', '2025-12-31', 250, 1, 0, 0, 0, 250, 0, 0.00, -1.0),
  ('eeee0701-0002-0003-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-01-01', '2026-01-31', 250, 2, 1, 0, 0, 125, 0, 0.00, -1.0),
  ('eeee0701-0002-0003-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-02-01', '2026-02-28', 250, 1, 1, 0, 0, 250, 0, 0.00, -1.0),
  ('eeee0701-0002-0003-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-03-01', '2026-03-31', 250, 1, 1, 0, 0, 250, 0, 0.00, -1.0),
  -- Google
  ('eeee0701-0002-0004-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'google', '2025-10-01', '2025-10-31', 200, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0002-0004-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'google', '2025-11-01', '2025-11-30', 200, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0002-0004-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'google', '2025-12-01', '2025-12-31', 200, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0002-0004-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'google', '2026-01-01', '2026-01-31', 250, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0002-0004-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'google', '2026-02-01', '2026-02-28', 250, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0002-0004-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'google', '2026-03-01', '2026-03-31', 300, 0, 0, 0, 0, 0, 0, 0.00, -1.0)
ON CONFLICT (id) DO NOTHING;

-- The Glass House — Top 4 sources: google, instagram, the_knot, referral
INSERT INTO source_attribution (id, venue_id, source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi) VALUES
  -- Google (dominant)
  ('eeee0701-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'google', '2025-10-01', '2025-10-31', 800, 3, 2, 1, 18500, 267, 800, 0.33, 22.1),
  ('eeee0701-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'google', '2025-11-01', '2025-11-30', 850, 2, 1, 1, 20000, 425, 850, 0.50, 22.5),
  ('eeee0701-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'google', '2025-12-01', '2025-12-31', 900, 1, 1, 0, 0, 900, 0, 0.00, -1.0),
  ('eeee0701-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'google', '2026-01-01', '2026-01-31', 950, 5, 3, 1, 22500, 190, 950, 0.20, 22.7),
  ('eeee0701-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'google', '2026-02-01', '2026-02-28', 1000, 3, 2, 0, 0, 333, 0, 0.00, -1.0),
  ('eeee0701-0003-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'google', '2026-03-01', '2026-03-31', 1050, 2, 1, 0, 0, 525, 0, 0.00, -1.0),
  -- Instagram (strong and growing)
  ('eeee0701-0003-0002-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'instagram', '2025-10-01', '2025-10-31', 400, 1, 1, 0, 0, 400, 0, 0.00, -1.0),
  ('eeee0701-0003-0002-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'instagram', '2025-11-01', '2025-11-30', 425, 2, 1, 1, 18500, 213, 425, 0.50, 42.5),
  ('eeee0701-0003-0002-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'instagram', '2025-12-01', '2025-12-31', 450, 1, 1, 1, 15800, 450, 450, 1.00, 34.1),
  ('eeee0701-0003-0002-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'instagram', '2026-01-01', '2026-01-31', 475, 3, 1, 1, 18500, 158, 475, 0.33, 37.9),
  ('eeee0701-0003-0002-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'instagram', '2026-02-01', '2026-02-28', 500, 2, 1, 0, 0, 250, 0, 0.00, -1.0),
  ('eeee0701-0003-0002-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'instagram', '2026-03-01', '2026-03-31', 525, 1, 0, 0, 0, 525, 0, 0.00, -1.0),
  -- The Knot
  ('eeee0701-0003-0003-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'the_knot', '2025-10-01', '2025-10-31', 400, 1, 0, 0, 0, 400, 0, 0.00, -1.0),
  ('eeee0701-0003-0003-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'the_knot', '2025-11-01', '2025-11-30', 400, 2, 2, 1, 18500, 200, 400, 0.50, 45.3),
  ('eeee0701-0003-0003-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'the_knot', '2025-12-01', '2025-12-31', 400, 1, 0, 0, 0, 400, 0, 0.00, -1.0),
  ('eeee0701-0003-0003-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'the_knot', '2026-01-01', '2026-01-31', 400, 2, 1, 1, 22500, 200, 400, 0.50, 55.3),
  ('eeee0701-0003-0003-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'the_knot', '2026-02-01', '2026-02-28', 400, 1, 1, 1, 16500, 400, 400, 1.00, 40.3),
  ('eeee0701-0003-0003-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'the_knot', '2026-03-01', '2026-03-31', 400, 1, 0, 0, 0, 400, 0, 0.00, -1.0),
  -- Referral
  ('eeee0701-0003-0004-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'referral', '2025-10-01', '2025-10-31', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0003-0004-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'referral', '2025-11-01', '2025-11-30', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0003-0004-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'referral', '2025-12-01', '2025-12-31', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0003-0004-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'referral', '2026-01-01', '2026-01-31', 0, 2, 1, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0003-0004-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'referral', '2026-02-01', '2026-02-28', 0, 1, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0003-0004-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'referral', '2026-03-01', '2026-03-31', 0, 1, 1, 0, 0, 0, 0, 0.00, 0)
ON CONFLICT (id) DO NOTHING;

-- Rose Hill Gardens — Top 4 sources: the_knot, facebook, google, referral
INSERT INTO source_attribution (id, venue_id, source, period_start, period_end, spend, inquiries, tours, bookings, revenue, cost_per_inquiry, cost_per_booking, conversion_rate, roi) VALUES
  -- The Knot
  ('eeee0701-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'the_knot', '2025-10-01', '2025-10-31', 300, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'the_knot', '2025-11-01', '2025-11-30', 300, 1, 1, 1, 14500, 300, 300, 1.00, 47.3),
  ('eeee0701-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'the_knot', '2025-12-01', '2025-12-31', 300, 1, 0, 0, 0, 300, 0, 0.00, -1.0),
  ('eeee0701-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'the_knot', '2026-01-01', '2026-01-31', 300, 2, 1, 1, 11800, 150, 300, 0.50, 38.3),
  ('eeee0701-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'the_knot', '2026-02-01', '2026-02-28', 300, 1, 1, 0, 0, 300, 0, 0.00, -1.0),
  ('eeee0701-0004-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'the_knot', '2026-03-01', '2026-03-31', 300, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  -- Facebook (surprising performer for Rose Hill)
  ('eeee0701-0004-0002-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'facebook', '2025-10-01', '2025-10-31', 250, 1, 0, 0, 0, 250, 0, 0.00, -1.0),
  ('eeee0701-0004-0002-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'facebook', '2025-11-01', '2025-11-30', 275, 1, 1, 0, 0, 275, 0, 0.00, -1.0),
  ('eeee0701-0004-0002-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'facebook', '2025-12-01', '2025-12-31', 300, 1, 1, 0, 0, 300, 0, 0.00, -1.0),
  ('eeee0701-0004-0002-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'facebook', '2026-01-01', '2026-01-31', 325, 2, 1, 0, 0, 163, 0, 0.00, -1.0),
  ('eeee0701-0004-0002-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'facebook', '2026-02-01', '2026-02-28', 350, 2, 1, 0, 0, 175, 0, 0.00, -1.0),
  ('eeee0701-0004-0002-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'facebook', '2026-03-01', '2026-03-31', 375, 1, 0, 0, 0, 375, 0, 0.00, -1.0),
  -- Google
  ('eeee0701-0004-0003-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'google', '2025-10-01', '2025-10-31', 350, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0004-0003-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'google', '2025-11-01', '2025-11-30', 375, 1, 0, 0, 0, 375, 0, 0.00, -1.0),
  ('eeee0701-0004-0003-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'google', '2025-12-01', '2025-12-31', 400, 0, 0, 0, 0, 0, 0, 0.00, -1.0),
  ('eeee0701-0004-0003-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'google', '2026-01-01', '2026-01-31', 425, 1, 1, 0, 0, 425, 0, 0.00, -1.0),
  ('eeee0701-0004-0003-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'google', '2026-02-01', '2026-02-28', 450, 1, 0, 0, 0, 450, 0, 0.00, -1.0),
  ('eeee0701-0004-0003-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'google', '2026-03-01', '2026-03-31', 475, 2, 1, 0, 0, 238, 0, 0.00, -1.0),
  -- Referral
  ('eeee0701-0004-0004-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'referral', '2025-10-01', '2025-10-31', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0004-0004-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'referral', '2025-11-01', '2025-11-30', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0004-0004-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'referral', '2025-12-01', '2025-12-31', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0004-0004-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'referral', '2026-01-01', '2026-01-31', 0, 1, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0004-0004-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'referral', '2026-02-01', '2026-02-28', 0, 0, 0, 0, 0, 0, 0, 0.00, 0),
  ('eeee0701-0004-0004-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'referral', '2026-03-01', '2026-03-31', 0, 0, 0, 0, 0, 0, 0, 0.00, 0)
ON CONFLICT (id) DO NOTHING;
-- Total: 96 rows


-- ============================================================
-- 8. MARKETING SPEND — channel spending per venue per month
-- ============================================================
-- Columns: id, venue_id, source, month, amount, notes

-- Rixey Manor — the_knot, google, instagram
INSERT INTO marketing_spend (id, venue_id, source, month, amount, notes) VALUES
  ('eeee0801-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'the_knot', '2025-10-01', 350, 'Standard listing'),
  ('eeee0801-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'the_knot', '2025-11-01', 350, 'Standard listing'),
  ('eeee0801-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'the_knot', '2025-12-01', 350, 'Standard listing'),
  ('eeee0801-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', 'google', '2025-10-01', 450, 'Google Ads — search'),
  ('eeee0801-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', 'google', '2025-11-01', 480, 'Google Ads — search'),
  ('eeee0801-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', 'google', '2025-12-01', 500, 'Google Ads — increased for holiday shoppers'),
  ('eeee0801-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', 'instagram', '2025-10-01', 150, 'Boosted posts'),
  ('eeee0801-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', 'instagram', '2025-11-01', 175, 'Boosted posts + reel'),
  ('eeee0801-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', 'instagram', '2025-12-01', 200, 'Holiday engagement content push')
ON CONFLICT (id) DO NOTHING;

-- Crestwood Farm — the_knot, weddingwire, google
INSERT INTO marketing_spend (id, venue_id, source, month, amount, notes) VALUES
  ('eeee0801-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'the_knot', '2025-10-01', 250, 'Standard listing'),
  ('eeee0801-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'the_knot', '2025-11-01', 250, 'Standard listing'),
  ('eeee0801-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', 'the_knot', '2025-12-01', 250, 'Standard listing'),
  ('eeee0801-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2025-10-01', 200, 'Basic listing'),
  ('eeee0801-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2025-11-01', 200, 'Basic listing'),
  ('eeee0801-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2025-12-01', 200, 'Basic listing'),
  ('eeee0801-0002-0001-0001-000000000007', '22222222-2222-2222-2222-222222222202', 'google', '2025-10-01', 200, 'Google Ads'),
  ('eeee0801-0002-0001-0001-000000000008', '22222222-2222-2222-2222-222222222202', 'google', '2025-11-01', 200, 'Google Ads'),
  ('eeee0801-0002-0001-0001-000000000009', '22222222-2222-2222-2222-222222222202', 'google', '2025-12-01', 200, 'Google Ads'),
  ('eeee0801-0002-0001-0001-000000000010', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-01-01', 250, 'Standard listing'),
  ('eeee0801-0002-0001-0001-000000000011', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-02-01', 250, 'Standard listing'),
  ('eeee0801-0002-0001-0001-000000000012', '22222222-2222-2222-2222-222222222202', 'the_knot', '2026-03-01', 250, 'Standard listing'),
  ('eeee0801-0002-0001-0001-000000000013', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2026-01-01', 200, 'Basic listing'),
  ('eeee0801-0002-0001-0001-000000000014', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2026-02-01', 200, 'Basic listing'),
  ('eeee0801-0002-0001-0001-000000000015', '22222222-2222-2222-2222-222222222202', 'weddingwire', '2026-03-01', 200, 'Basic listing'),
  ('eeee0801-0002-0001-0001-000000000016', '22222222-2222-2222-2222-222222222202', 'google', '2026-01-01', 250, 'Google Ads — increased for Jan'),
  ('eeee0801-0002-0001-0001-000000000017', '22222222-2222-2222-2222-222222222202', 'google', '2026-02-01', 250, 'Google Ads'),
  ('eeee0801-0002-0001-0001-000000000018', '22222222-2222-2222-2222-222222222202', 'google', '2026-03-01', 300, 'Google Ads — spring push')
ON CONFLICT (id) DO NOTHING;

-- The Glass House — google, instagram, the_knot
INSERT INTO marketing_spend (id, venue_id, source, month, amount, notes) VALUES
  ('eeee0801-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'google', '2025-10-01', 800, 'Google Ads — search + display'),
  ('eeee0801-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'google', '2025-11-01', 850, 'Google Ads'),
  ('eeee0801-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'google', '2025-12-01', 900, 'Google Ads — holiday increase'),
  ('eeee0801-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'google', '2026-01-01', 950, 'Google Ads — peak season'),
  ('eeee0801-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', 'google', '2026-02-01', 1000, 'Google Ads — CPI climbing'),
  ('eeee0801-0003-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', 'google', '2026-03-01', 1050, 'Google Ads'),
  ('eeee0801-0003-0001-0001-000000000007', '22222222-2222-2222-2222-222222222203', 'instagram', '2025-10-01', 400, 'Instagram Ads + Reels'),
  ('eeee0801-0003-0001-0001-000000000008', '22222222-2222-2222-2222-222222222203', 'instagram', '2025-11-01', 425, 'Instagram Ads + Reels'),
  ('eeee0801-0003-0001-0001-000000000009', '22222222-2222-2222-2222-222222222203', 'instagram', '2025-12-01', 450, 'Instagram Ads — night aesthetic push'),
  ('eeee0801-0003-0001-0001-000000000010', '22222222-2222-2222-2222-222222222203', 'instagram', '2026-01-01', 475, 'Instagram Ads'),
  ('eeee0801-0003-0001-0001-000000000011', '22222222-2222-2222-2222-222222222203', 'instagram', '2026-02-01', 500, 'Instagram Ads'),
  ('eeee0801-0003-0001-0001-000000000012', '22222222-2222-2222-2222-222222222203', 'instagram', '2026-03-01', 525, 'Instagram Ads'),
  ('eeee0801-0003-0001-0001-000000000013', '22222222-2222-2222-2222-222222222203', 'the_knot', '2025-10-01', 400, 'Premium listing'),
  ('eeee0801-0003-0001-0001-000000000014', '22222222-2222-2222-2222-222222222203', 'the_knot', '2025-11-01', 400, 'Premium listing'),
  ('eeee0801-0003-0001-0001-000000000015', '22222222-2222-2222-2222-222222222203', 'the_knot', '2025-12-01', 400, 'Premium listing'),
  ('eeee0801-0003-0001-0001-000000000016', '22222222-2222-2222-2222-222222222203', 'the_knot', '2026-01-01', 400, 'Premium listing'),
  ('eeee0801-0003-0001-0001-000000000017', '22222222-2222-2222-2222-222222222203', 'the_knot', '2026-02-01', 400, 'Premium listing'),
  ('eeee0801-0003-0001-0001-000000000018', '22222222-2222-2222-2222-222222222203', 'the_knot', '2026-03-01', 400, 'Premium listing')
ON CONFLICT (id) DO NOTHING;

-- Rose Hill Gardens — the_knot, facebook, google
INSERT INTO marketing_spend (id, venue_id, source, month, amount, notes) VALUES
  ('eeee0801-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'the_knot', '2025-10-01', 300, 'Standard listing'),
  ('eeee0801-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'the_knot', '2025-11-01', 300, 'Standard listing'),
  ('eeee0801-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'the_knot', '2025-12-01', 300, 'Standard listing'),
  ('eeee0801-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', 'the_knot', '2026-01-01', 300, 'Standard listing'),
  ('eeee0801-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'the_knot', '2026-02-01', 300, 'Standard listing'),
  ('eeee0801-0004-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', 'the_knot', '2026-03-01', 300, 'Standard listing'),
  ('eeee0801-0004-0001-0001-000000000007', '22222222-2222-2222-2222-222222222204', 'facebook', '2025-10-01', 250, 'Facebook Ads — garden photos'),
  ('eeee0801-0004-0001-0001-000000000008', '22222222-2222-2222-2222-222222222204', 'facebook', '2025-11-01', 275, 'Facebook Ads'),
  ('eeee0801-0004-0001-0001-000000000009', '22222222-2222-2222-2222-222222222204', 'facebook', '2025-12-01', 300, 'Facebook Ads — holiday engagement'),
  ('eeee0801-0004-0001-0001-000000000010', '22222222-2222-2222-2222-222222222204', 'facebook', '2026-01-01', 325, 'Facebook Ads'),
  ('eeee0801-0004-0001-0001-000000000011', '22222222-2222-2222-2222-222222222204', 'facebook', '2026-02-01', 350, 'Facebook Ads'),
  ('eeee0801-0004-0001-0001-000000000012', '22222222-2222-2222-2222-222222222204', 'facebook', '2026-03-01', 375, 'Facebook Ads — spring bloom push'),
  ('eeee0801-0004-0001-0001-000000000013', '22222222-2222-2222-2222-222222222204', 'google', '2025-10-01', 350, 'Google Ads'),
  ('eeee0801-0004-0001-0001-000000000014', '22222222-2222-2222-2222-222222222204', 'google', '2025-11-01', 375, 'Google Ads'),
  ('eeee0801-0004-0001-0001-000000000015', '22222222-2222-2222-2222-222222222204', 'google', '2025-12-01', 400, 'Google Ads'),
  ('eeee0801-0004-0001-0001-000000000016', '22222222-2222-2222-2222-222222222204', 'google', '2026-01-01', 425, 'Google Ads'),
  ('eeee0801-0004-0001-0001-000000000017', '22222222-2222-2222-2222-222222222204', 'google', '2026-02-01', 450, 'Google Ads'),
  ('eeee0801-0004-0001-0001-000000000018', '22222222-2222-2222-2222-222222222204', 'google', '2026-03-01', 475, 'Google Ads — spring push')
ON CONFLICT (id) DO NOTHING;
-- Total: 63 rows


-- ============================================================
-- 9. INTERACTIONS — 25 realistic email threads across venues
-- ============================================================
-- Focus on recent emails (last 2-4 weeks) to make inbox feel alive
-- Columns: id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp

INSERT INTO interactions (id, venue_id, wedding_id, person_id, type, direction, subject, body_preview, timestamp) VALUES
  -- Rixey Manor — recent threads
  ('eeee0901-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '55555555-5555-5555-5555-555555000301', 'email', 'inbound', 'Question about catering setup day', 'Hi Sarah! Quick question — can our caterer access the kitchen the morning of, or do they need to come the day before? We are finalizing our timeline with Mountain Crust...', '2026-03-18 09:30:00+00'),
  ('eeee0901-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', '55555555-5555-5555-5555-555555000301', 'email', 'outbound', 'Re: Question about catering setup day', 'Hi Chloe! Great question. Your caterer can absolutely access the kitchen starting at 8am the morning of. We also have a prep area behind the barn if they need extra space...', '2026-03-18 11:15:00+00'),
  ('eeee0901-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', NULL, 'email', 'inbound', 'Re: Proposal for November 7th', 'Hi Sage, thank you for the detailed proposal. We are discussing it this weekend. One question — is the ceremony site fee included or separate?', '2026-03-20 14:00:00+00'),
  ('eeee0901-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', NULL, 'email', 'outbound', 'Re: Proposal for November 7th', 'Great news that you are reviewing! The ceremony site is absolutely included in the venue rental — no separate fee. You have full access to all ceremony locations on the property...', '2026-03-20 15:30:00+00'),
  ('eeee0901-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', NULL, 'email', 'inbound', 'Excited for our tour!', 'Hi! Just confirming we are all set for our tour on April 1st at 11am. Is there anything we should bring or know beforehand? We are driving from Arlington.', '2026-03-22 10:00:00+00'),
  ('eeee0901-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', NULL, 'email', 'outbound', 'Re: Excited for our tour!', 'We are so excited to meet you! April 1st at 11am is confirmed. Just a few tips: wear comfortable shoes (we will walk the grounds), and feel free to bring your photographer if you want to see the light. The drive from Arlington is about 90 minutes — very scenic!', '2026-03-22 11:45:00+00'),

  -- Crestwood Farm — recent threads
  ('eeee0901-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000209', '55555555-5555-5555-5555-555555000401', 'email', 'inbound', 'Vendor recommendation needed', 'Hey Jake! Do you have a bartending service you would recommend for our June wedding? We need someone who can handle craft cocktails for about 115 guests.', '2026-03-16 13:00:00+00'),
  ('eeee0901-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000209', '55555555-5555-5555-5555-555555000401', 'email', 'outbound', 'Re: Vendor recommendation needed', 'Hey Taylor! Absolutely — our top recommendation is Blue Ridge Bar Co. They do amazing craft cocktails and they know our space really well. I will send you their contact info...', '2026-03-16 14:30:00+00'),
  ('eeee0901-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000211', NULL, 'email', 'inbound', 'Following up on our tour', 'Hi Sage! We just wanted to say how much we loved visiting Crestwood Farm last weekend. The barn was even more beautiful than the photos. We are seriously considering it for our October wedding.', '2026-03-19 09:00:00+00'),
  ('eeee0901-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000211', NULL, 'email', 'outbound', 'Re: Following up on our tour', 'Hey! Oh that makes me so happy to hear! Y''all were such a fun couple to show around. October is absolutely gorgeous here — the leaves start turning and the meadow gets this golden glow. Want me to put together a proposal for October dates?', '2026-03-19 10:30:00+00'),
  ('eeee0901-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', NULL, 'email', 'inbound', 'Re: Barn venue for intimate wedding?', 'Thanks for the quick reply Sage! We would love to come see the space. Does Saturday March 29th work? Around 2pm?', '2026-03-24 08:00:00+00'),
  ('eeee0901-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', NULL, 'email', 'outbound', 'Re: Barn venue for intimate wedding?', 'Saturday the 29th at 2pm is perfect! I will have the barn open and the string lights on. Fair warning — it looks even better in person. See y''all then!', '2026-03-24 09:15:00+00'),

  -- The Glass House — recent threads
  ('eeee0901-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000318', NULL, 'email', 'inbound', 'Tasting menu options', 'Hello Nova, we received the proposal and are very interested. Before we commit, could we schedule a tasting with your in-house chef? We have some dietary restrictions to discuss.', '2026-03-14 11:00:00+00'),
  ('eeee0901-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000318', NULL, 'email', 'outbound', 'Re: Tasting menu options', 'Hello, Thank you for your interest. I would be happy to arrange a tasting. Our chef can accommodate most dietary requirements. I have availability on April 5th at 6pm or April 12th at 1pm. Please let me know your preference and any dietary details.', '2026-03-14 13:00:00+00'),
  ('eeee0901-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000316', NULL, 'email', 'inbound', 'Floor plan question for October wedding', 'Hi Maya, quick question about our October wedding. Can we do a theater-style ceremony in the main hall and then flip it for dinner? How long does the turnaround take?', '2026-03-21 15:00:00+00'),
  ('eeee0901-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000316', NULL, 'email', 'outbound', 'Re: Floor plan question for October wedding', 'Hello, Great question. Yes, our team handles the turnaround in approximately 45 minutes while your guests enjoy cocktails on the terrace. We have done this configuration many times for groups of 245. I will send you the floor plan options by Friday.', '2026-03-21 16:30:00+00'),
  ('eeee0901-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', '55555555-5555-5555-5555-555555000501', 'email', 'inbound', 'Re: Large wedding at The Glass House', 'Thank you for the details Nova. We would love to schedule a walkthrough. Does next Saturday afternoon work? Also, can we see the space set up for a similar-sized event?', '2026-03-25 10:00:00+00'),

  -- Rose Hill Gardens — recent threads
  ('eeee0901-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000407', '55555555-5555-5555-5555-555555000601', 'email', 'inbound', 'Garden ceremony timing', 'Hi Olivia! We are working on our timeline for May. What time does the garden look best for photos? Our photographer wants to know about golden hour at your location.', '2026-03-17 10:00:00+00'),
  ('eeee0901-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000407', '55555555-5555-5555-5555-555555000601', 'email', 'outbound', 'Re: Garden ceremony timing', 'Hello lovely! Great question. In May, golden hour is around 7:15-7:45pm. For the best garden photos, I recommend scheduling your ceremony for 5pm — the rose garden is in full bloom and the light coming through the old oak is magical. I can share some sample timelines from past May weddings!', '2026-03-17 12:00:00+00'),
  ('eeee0901-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', NULL, 'email', 'inbound', 'Tour availability this weekend?', 'Hi there, I saw your venue on Instagram and I am in love! My fiance and I are looking for a garden venue for about 110 guests. Do you have any tour times available this weekend?', '2026-03-20 16:00:00+00'),
  ('eeee0901-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', NULL, 'email', 'outbound', 'Re: Tour availability this weekend?', 'Hello lovely! How wonderful — I can already picture a beautiful celebration here for 110 guests! We have Saturday at 11am or Sunday at 2pm open this weekend. The spring blooms are just starting to show and it is going to be gorgeous. Which works better for you?', '2026-03-20 17:30:00+00'),
  ('eeee0901-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000408', NULL, 'email', 'inbound', 'Tent options for September backup', 'Hi Bloom, we are looking into rain backup plans for our September wedding. Do you have a preferred tent rental company? And where would the tent go?', '2026-03-23 11:00:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 25 interactions


-- ============================================================
-- 10. DRAFTS — AI-generated drafts in various states
-- ============================================================
-- Columns: id, venue_id, wedding_id, interaction_id, to_email, subject, draft_body,
--          status, context_type, brain_used, model_used, tokens_used, cost,
--          confidence_score, auto_sent, feedback_notes, approved_by, approved_at

INSERT INTO drafts (id, venue_id, wedding_id, interaction_id, to_email, subject, draft_body, status, context_type, brain_used, model_used, tokens_used, cost, confidence_score, auto_sent, approved_by, approved_at, created_at) VALUES
  -- PENDING: Rixey — reply to proposal follow-up (waiting for Sarah)
  ('eeee1001-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 'eeee0901-0001-0001-0001-000000000003', NULL, 'Re: Proposal for November 7th',
   'Great news that you are reviewing! The ceremony site is absolutely included in the venue rental — no separate fee. You have full access to all ceremony locations on the property, including the hilltop overlook, the garden terrace, and the oak grove. Most of our November couples choose the hilltop for the autumn foliage backdrop. Would you like to schedule a quick call to walk through the proposal details together? Warmly, Sage',
   'pending', 'inquiry', 'inquiry_reply', 'claude-sonnet-4-20250514', 1320, 0.0048, 91, false, NULL, NULL, '2026-03-20 14:05:00+00'),

  -- PENDING: Rose Hill — tent backup question (waiting for Olivia)
  ('eeee1001-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000408', 'eeee0901-0004-0001-0001-000000000005', NULL, 'Re: Tent options for September backup',
   'Hello lovely! Great thinking on the rain backup — September can surprise us! We work with Blue Ridge Tent Co. and they are wonderful. The tent would go on the north lawn, which gives you a gorgeous view of the garden even under cover. For 135 guests, you would want the 40x60 frame tent. I can send you their contact info and a layout showing exactly where it goes. With joy, Bloom',
   'pending', 'client', 'inquiry_reply', 'claude-sonnet-4-20250514', 1180, 0.0042, 87, false, NULL, NULL, '2026-03-23 11:10:00+00'),

  -- PENDING: Glass House — walkthrough scheduling (waiting for Maya)
  ('eeee1001-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 'eeee0901-0003-0001-0001-000000000005', 'priya.sharma@gmail.com', 'Re: Large wedding at The Glass House',
   'Hello Priya, Thank you for your enthusiasm. Next Saturday afternoon works perfectly. I have 2pm available for your walkthrough. While we cannot guarantee a similar-sized event setup that day, I will have our floor plan software ready to show you the 210-guest configuration. Please allow approximately 90 minutes for the full tour. Best regards, Nova',
   'pending', 'inquiry', 'inquiry_reply', 'claude-sonnet-4-20250514', 1050, 0.0036, 93, false, NULL, NULL, '2026-03-25 10:15:00+00'),

  -- PENDING: Crestwood — tour confirmation
  ('eeee1001-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', 'eeee0901-0002-0001-0001-000000000005', NULL, 'Re: Barn venue for intimate wedding?',
   'Saturday the 29th at 2pm is perfect! I will have the barn doors open and the string lights on so y''all can see it in all its glory. Fair warning — it looks even better in person than the photos. Just head down the gravel drive and park by the big red barn. Can''t wait to meet y''all! Sage',
   'pending', 'inquiry', 'inquiry_reply', 'claude-sonnet-4-20250514', 980, 0.0034, 94, false, NULL, NULL, '2026-03-24 08:10:00+00'),

  -- APPROVED+SENT: Rixey — catering question reply
  ('eeee1001-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'eeee0901-0001-0001-0001-000000000001', 'chloe.m@gmail.com', 'Re: Question about catering setup day',
   'Hi Chloe! Great question. Your caterer can absolutely access the kitchen starting at 8am the morning of. We also have a prep area behind the barn if they need extra space. Mountain Crust is fantastic — they have done several weddings here and know the layout well. Let me know if your caterer needs the floor plan for the kitchen! Warmly, Sage',
   'sent', 'client', 'inquiry_reply', 'claude-sonnet-4-20250514', 1150, 0.0041, 95, false, '33333333-3333-3333-3333-333333333301', '2026-03-18 11:00:00+00', '2026-03-18 09:35:00+00'),

  -- APPROVED+SENT: Rixey — tour confirmation
  ('eeee1001-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 'eeee0901-0001-0001-0001-000000000005', NULL, 'Re: Excited for our tour!',
   'We are so excited to meet you! April 1st at 11am is confirmed. Just a few tips for your visit: wear comfortable shoes as we will walk the grounds, and feel free to bring your photographer if you want to see the light. The drive from Arlington is about 90 minutes and very scenic once you get past Gainesville. We will have coffee and pastries waiting! Warmly, Sage',
   'sent', 'inquiry', 'inquiry_reply', 'claude-sonnet-4-20250514', 1280, 0.0046, 92, false, '33333333-3333-3333-3333-333333333301', '2026-03-22 11:30:00+00', '2026-03-22 10:05:00+00'),

  -- APPROVED+SENT: Glass House — floor plan reply
  ('eeee1001-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000316', 'eeee0901-0003-0001-0001-000000000003', NULL, 'Re: Floor plan question for October wedding',
   'Hello, Great question. Yes, our team handles the turnaround in approximately 45 minutes while your guests enjoy cocktails on the terrace. We have done this configuration many times for groups of 245 and it works beautifully. I will send you the floor plan options by Friday, including both theater-style and in-the-round ceremony layouts. Best regards, Nova',
   'sent', 'client', 'inquiry_reply', 'claude-sonnet-4-20250514', 1100, 0.0038, 94, false, '33333333-3333-3333-3333-333333333303', '2026-03-21 16:15:00+00', '2026-03-21 15:05:00+00'),

  -- REJECTED: Crestwood — tone was too formal, Jake wanted it warmer
  ('eeee1001-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000211', 'eeee0901-0002-0001-0001-000000000003', NULL, 'Re: Following up on our tour',
   'Dear couple, Thank you for your kind words about your visit to Crestwood Farm. We are pleased you enjoyed the tour. Should you wish to proceed, we would be happy to prepare a formal proposal for your October wedding. Please let us know your preferred date. Regards, Sage',
   'rejected', 'inquiry', 'inquiry_reply', 'claude-sonnet-4-20250514', 950, 0.0032, 72, false, NULL, NULL, '2026-03-19 09:05:00+00'),

  -- REJECTED: Rose Hill — too pushy on the close
  ('eeee1001-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', 'eeee0901-0004-0001-0001-000000000003', NULL, 'Re: Tour availability this weekend?',
   'Hi there! We would love to show you Rose Hill Gardens. We have limited availability this spring and dates are filling fast. I would recommend booking a tour immediately and putting down a deposit to hold your preferred date. We have Saturday at 11am or Sunday at 2pm. Which works?',
   'rejected', 'inquiry', 'inquiry_brain', 'claude-sonnet-4-20250514', 880, 0.0030, 68, false, NULL, NULL, '2026-03-20 16:05:00+00'),

  -- AUTO-SENT: Crestwood — high-confidence acknowledgment
  ('eeee1001-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000209', 'eeee0901-0002-0001-0001-000000000001', 'taylor.kim@gmail.com', 'Re: Vendor recommendation needed',
   'Hey Taylor! Absolutely — our top recommendation is Blue Ridge Bar Co. They do amazing craft cocktails and they know our space really well. Tell them Crestwood Farm sent you and they will take great care of y''all. I will email you their contact info separately. Can''t wait to meet y''all! Sage',
   'sent', 'client', 'inquiry_reply', 'claude-sonnet-4-20250514', 920, 0.0032, 96, true, NULL, NULL, '2026-03-16 13:02:00+00'),

  -- AUTO-SENT: Rixey — 3-day follow-up on an older lead
  ('eeee1001-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000110', NULL, 'NULL', 'Following up on your visit to Rixey Manor',
   'Hi there! Just wanted to check in after your tour last week. I hope you both had a chance to talk about what you saw. We had such a lovely time showing you around, and I think your June wedding would be absolutely beautiful here. No pressure at all — just wanted to make sure you had everything you needed to make your decision. If you have any questions, I am always here! Warmly, Sage',
   'sent', 'inquiry', 'follow_up_3_day', 'claude-sonnet-4-20250514', 1380, 0.0050, 88, true, NULL, NULL, '2026-03-12 08:00:00+00'),

  -- APPROVED+SENT: Rose Hill — garden ceremony timing
  ('eeee1001-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000407', 'eeee0901-0004-0001-0001-000000000001', 'lily.nguyen@gmail.com', 'Re: Garden ceremony timing',
   'Hello lovely! Great question. In May, golden hour is around 7:15-7:45pm. For the best garden photos, I recommend scheduling your ceremony for 5pm — the rose garden is in full bloom and the light coming through the old oak is magical. I can share some sample timelines from past May weddings if that would help! With joy, Bloom',
   'sent', 'client', 'inquiry_reply', 'claude-sonnet-4-20250514', 1100, 0.0038, 93, false, '33333333-3333-3333-3333-333333333304', '2026-03-17 11:45:00+00', '2026-03-17 10:05:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 12 drafts


-- ============================================================
-- 11. ENGAGEMENT EVENTS — heat mapping activity
-- ============================================================
-- Columns: id, venue_id, wedding_id, event_type, points, metadata (jsonb), created_at

INSERT INTO engagement_events (id, venue_id, wedding_id, event_type, points, metadata, created_at) VALUES
  -- Rixey Manor active leads
  ('eeee1101-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'email_reply', 15, '{"subject": "Catering setup day"}', '2026-03-18 09:30:00+00'),
  ('eeee1101-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'page_view', 1, '{"page": "/portal/timeline"}', '2026-03-17 20:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 'page_view', 1, '{"page": "/portal/vendors"}', '2026-03-17 20:05:00+00'),
  ('eeee1101-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 'email_reply', 15, '{"subject": "Proposal follow-up"}', '2026-03-20 14:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 'pricing_page_view', 5, '{"page": "/pricing"}', '2026-03-19 22:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 'contract_sent', 30, '{"contract_value": 13000}', '2026-02-25 10:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000007', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 'initial_inquiry', 40, '{"source": "the_knot", "guest_count": 200}', '2026-03-15 12:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000008', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 'email_reply', 15, '{"subject": "Excited for tour"}', '2026-03-22 10:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000009', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 'tour_scheduled', 20, '{"tour_date": "2026-04-01"}', '2026-03-22 11:45:00+00'),
  ('eeee1101-0001-0001-0001-000000000010', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000115', 'initial_inquiry', 40, '{"source": "google", "guest_count": 100}', '2026-03-24 14:30:00+00'),
  ('eeee1101-0001-0001-0001-000000000011', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000116', 'initial_inquiry', 40, '{"source": "website", "guest_count": 80}', '2026-03-26 10:15:00+00'),
  ('eeee1101-0001-0001-0001-000000000012', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000116', 'no_response_week', -10, '{"hours_since_inquiry": 48}', '2026-03-28 10:15:00+00'),
  -- Older events showing journey: inquiry -> warm -> booked
  ('eeee1101-0001-0001-0001-000000000013', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 'initial_inquiry', 40, '{"source": "instagram"}', '2026-01-10 12:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000014', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 'tour_scheduled', 20, '{"tour_date": "2026-01-25"}', '2026-01-15 10:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000015', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 'tour_completed', 25, '{}', '2026-01-25 14:00:00+00'),
  ('eeee1101-0001-0001-0001-000000000016', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 'contract_sent', 30, '{"contract_value": 14800}', '2026-02-05 09:00:00+00'),

  -- Crestwood Farm
  ('eeee1101-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000209', 'email_reply', 15, '{"subject": "Vendor recommendation"}', '2026-03-16 13:00:00+00'),
  ('eeee1101-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000211', 'tour_completed', 25, '{}', '2026-03-15 14:00:00+00'),
  ('eeee1101-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000211', 'email_reply', 15, '{"subject": "Following up on tour"}', '2026-03-19 09:00:00+00'),
  ('eeee1101-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', 'initial_inquiry', 40, '{"source": "the_knot", "guest_count": 90}', '2026-03-22 09:00:00+00'),
  ('eeee1101-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', 'email_reply', 15, '{"subject": "Tour scheduling"}', '2026-03-24 08:00:00+00'),
  ('eeee1101-0002-0001-0001-000000000006', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', 'tour_scheduled', 20, '{"tour_date": "2026-03-29"}', '2026-03-24 09:15:00+00'),
  ('eeee1101-0002-0001-0001-000000000007', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000210', 'initial_inquiry', 40, '{"source": "instagram"}', '2025-12-15 10:00:00+00'),
  ('eeee1101-0002-0001-0001-000000000008', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000210', 'tour_completed', 25, '{}', '2026-01-05 14:00:00+00'),
  ('eeee1101-0002-0001-0001-000000000009', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000210', 'contract_sent', 30, '{"contract_value": 10200}', '2026-01-15 09:00:00+00'),

  -- The Glass House
  ('eeee1101-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 'initial_inquiry', 40, '{"source": "google", "guest_count": 210}', '2026-03-20 11:30:00+00'),
  ('eeee1101-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 'email_reply', 15, '{"subject": "Walkthrough request"}', '2026-03-25 10:00:00+00'),
  ('eeee1101-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 'pricing_page_view', 5, '{"page": "/pricing"}', '2026-03-22 21:00:00+00'),
  ('eeee1101-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000318', 'email_reply', 15, '{"subject": "Tasting request"}', '2026-03-14 11:00:00+00'),
  ('eeee1101-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000316', 'email_reply', 15, '{"subject": "Floor plan question"}', '2026-03-21 15:00:00+00'),
  ('eeee1101-0003-0001-0001-000000000006', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000317', 'initial_inquiry', 40, '{"source": "instagram"}', '2026-02-01 10:00:00+00'),
  ('eeee1101-0003-0001-0001-000000000007', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000317', 'tour_completed', 25, '{}', '2026-02-15 14:00:00+00'),
  ('eeee1101-0003-0001-0001-000000000008', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000317', 'contract_sent', 30, '{"contract_value": 18500}', '2026-02-25 09:00:00+00'),

  -- Rose Hill Gardens
  ('eeee1101-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000407', 'email_reply', 15, '{"subject": "Garden timing"}', '2026-03-17 10:00:00+00'),
  ('eeee1101-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', 'initial_inquiry', 40, '{"source": "instagram", "guest_count": 110}', '2026-03-10 12:00:00+00'),
  ('eeee1101-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', 'email_reply', 15, '{"subject": "Tour request"}', '2026-03-20 16:00:00+00'),
  ('eeee1101-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', 'tour_scheduled', 20, '{"tour_date": "2026-03-28"}', '2026-03-20 17:30:00+00'),
  ('eeee1101-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000410', 'initial_inquiry', 40, '{"source": "google", "guest_count": 90}', '2026-03-25 12:00:00+00'),
  ('eeee1101-0004-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000410', 'no_response_week', -10, '{"hours_since_inquiry": 72}', '2026-03-28 12:00:00+00'),
  ('eeee1101-0004-0001-0001-000000000007', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000408', 'initial_inquiry', 40, '{"source": "referral"}', '2025-12-20 10:00:00+00'),
  ('eeee1101-0004-0001-0001-000000000008', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000408', 'tour_completed', 25, '{}', '2026-01-05 14:00:00+00'),
  ('eeee1101-0004-0001-0001-000000000009', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000408', 'contract_sent', 30, '{"contract_value": 11800}', '2026-01-15 09:00:00+00'),
  ('eeee1101-0004-0001-0001-000000000010', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000408', 'email_reply', 15, '{"subject": "Tent backup plan"}', '2026-03-23 11:00:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 48 engagement events


-- ============================================================
-- 12. LEAD SCORE HISTORY — score snapshots showing journeys
-- ============================================================
-- Columns: id, venue_id, wedding_id, score, temperature_tier, calculated_at

INSERT INTO lead_score_history (id, venue_id, wedding_id, score, temperature_tier, calculated_at) VALUES
  -- Rixey 109 (Chloe & Ryan) — booked journey
  ('eeee1201-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 40, 'cool', '2025-10-15 12:00:00+00'),
  ('eeee1201-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 60, 'warm', '2025-10-20 14:00:00+00'),
  ('eeee1201-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 75, 'warm', '2025-11-01 10:00:00+00'),
  ('eeee1201-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000109', 72, 'warm', '2026-03-18 09:30:00+00'),

  -- Rixey 112 (Instagram lead) — warming to booked
  ('eeee1201-0001-0002-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 40, 'cool', '2026-01-10 12:00:00+00'),
  ('eeee1201-0001-0002-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 55, 'warm', '2026-01-15 10:00:00+00'),
  ('eeee1201-0001-0002-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 70, 'warm', '2026-01-25 14:00:00+00'),
  ('eeee1201-0001-0002-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000112', 60, 'warm', '2026-02-10 10:00:00+00'),

  -- Rixey 113 (proposal pending) — warming
  ('eeee1201-0001-0003-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 40, 'cool', '2026-02-20 12:00:00+00'),
  ('eeee1201-0001-0003-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 65, 'warm', '2026-03-05 14:00:00+00'),
  ('eeee1201-0001-0003-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000113', 78, 'warm', '2026-03-20 14:00:00+00'),

  -- Rixey 114 (tour scheduled) — hot
  ('eeee1201-0001-0004-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 40, 'cool', '2026-03-15 12:00:00+00'),
  ('eeee1201-0001-0004-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 75, 'warm', '2026-03-22 11:45:00+00'),
  ('eeee1201-0001-0004-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000114', 85, 'hot', '2026-03-25 08:00:00+00'),

  -- Rixey 117 (lost deal) — cooling journey
  ('eeee1201-0001-0005-0001-000000000001', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000117', 40, 'cool', '2024-10-01 12:00:00+00'),
  ('eeee1201-0001-0005-0001-000000000002', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000117', 55, 'warm', '2024-10-15 14:00:00+00'),
  ('eeee1201-0001-0005-0001-000000000003', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000117', 35, 'cool', '2024-11-15 10:00:00+00'),
  ('eeee1201-0001-0005-0001-000000000004', '22222222-2222-2222-2222-222222222201', '44444444-4444-4444-4444-444444000117', 10, 'frozen', '2024-12-15 10:00:00+00'),

  -- Crestwood 211 (tour completed, deciding)
  ('eeee1201-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000211', 40, 'cool', '2026-03-01 12:00:00+00'),
  ('eeee1201-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000211', 65, 'warm', '2026-03-15 14:00:00+00'),
  ('eeee1201-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000211', 70, 'warm', '2026-03-19 09:00:00+00'),

  -- Crestwood 212 (hot inquiry)
  ('eeee1201-0002-0002-0001-000000000001', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', 40, 'cool', '2026-03-22 09:00:00+00'),
  ('eeee1201-0002-0002-0001-000000000002', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', 75, 'warm', '2026-03-24 09:15:00+00'),
  ('eeee1201-0002-0002-0001-000000000003', '22222222-2222-2222-2222-222222222202', '44444444-4444-4444-4444-444444000212', 88, 'hot', '2026-03-27 08:00:00+00'),

  -- Glass House 319 (Priya & Nico — hot)
  ('eeee1201-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 40, 'cool', '2026-03-20 11:30:00+00'),
  ('eeee1201-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 70, 'warm', '2026-03-22 21:00:00+00'),
  ('eeee1201-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '44444444-4444-4444-4444-444444000319', 92, 'hot', '2026-03-25 10:00:00+00'),

  -- Rose Hill 409 (tour scheduled — warming)
  ('eeee1201-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', 40, 'cool', '2026-03-10 12:00:00+00'),
  ('eeee1201-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', 65, 'warm', '2026-03-20 17:30:00+00'),
  ('eeee1201-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000409', 80, 'warm', '2026-03-25 08:00:00+00'),

  -- Rose Hill 410 (hot but no response — decaying)
  ('eeee1201-0004-0002-0001-000000000001', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000410', 40, 'cool', '2026-03-25 12:00:00+00'),
  ('eeee1201-0004-0002-0001-000000000002', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000410', 93, 'hot', '2026-03-25 12:05:00+00'),
  ('eeee1201-0004-0002-0001-000000000003', '22222222-2222-2222-2222-222222222204', '44444444-4444-4444-4444-444444000410', 83, 'warm', '2026-03-28 12:00:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 35 score history entries


-- ============================================================
-- 13. TREND RECOMMENDATIONS — AI recommendations from trends
-- ============================================================
-- Columns: id, venue_id, recommendation_type, title, body, data_source,
--          supporting_data, priority, status

INSERT INTO trend_recommendations (id, venue_id, recommendation_type, title, body, data_source, supporting_data, priority, status, created_at) VALUES
  -- Rixey Manor
  ('eeee1301-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', 'content', 'Refresh The Knot gallery with spring photos', '"Wedding venue" searches in your metro surged 93% from December to March. This is your highest-visibility window. Refresh your The Knot gallery with spring photos to capture peak browsing traffic.', 'google_trends', '{"term": "wedding venue", "change_pct": 93, "dec_value": 38, "mar_value": 93}', 'high', 'pending', '2026-03-15 08:00:00+00'),

  ('eeee1301-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', 'engagement', 'Holiday engagement wave predicts strong April inquiries', 'Engagement ring searches peaked at 95 in December, 38% higher than October. Based on the typical 3-6 month engagement-to-inquiry pipeline, expect above-average inquiry volume through May. Ensure tour slots are open.', 'google_trends', '{"term": "engagement ring", "dec_peak": 95, "oct_baseline": 58, "expected_inquiry_lift": "20-35%"}', 'medium', 'pending', '2026-01-15 08:00:00+00'),

  ('eeee1301-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'pricing', 'Demand supports a modest price increase for peak dates', 'Your booking rate held steady at 35% even as inquiry volume doubled. This suggests you have pricing headroom. Consider a $500 increase for peak season Saturdays (May-Oct). Your competitors in the Culpeper area have raised prices 8% this year.', 'market_analysis', '{"current_rate": 8500, "suggested_rate": 9000, "competitor_avg_increase": "8%", "booking_rate": 0.35}', 'medium', 'pending', '2026-02-20 08:00:00+00'),

  -- Crestwood Farm
  ('eeee1301-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'content', 'Barn wedding searches up 23% — feature your renovation', '"Barn wedding" searches in your metro are up 23% month-over-month. This is your moment. Feature the barn renovation in your next Instagram post and update your listing primary photo to show the new string lights.', 'google_trends', '{"term": "barn wedding", "change_pct": 23, "feb_value": 62, "jan_value": 55}', 'high', 'applied', '2026-03-01 08:00:00+00'),

  ('eeee1301-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', 'engagement', 'Referral program would formalize your strongest channel', 'Referrals produced 71% of your February inquiries at zero acquisition cost. A formal referral thank-you program (gift card, complimentary rehearsal dinner appetizers) would incentivize more and cost far less than paid channels.', 'source_attribution', '{"referral_share": 0.71, "avg_paid_cpi": 225, "referral_cpi": 0, "suggested_incentive": "$100 gift card"}', 'high', 'pending', '2026-03-10 08:00:00+00'),

  -- The Glass House
  ('eeee1301-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', 'content', 'Instagram Reels driving real leads — double down', 'Your Instagram Reels featuring the venue at night generated 15K views and directly produced 3 inquiries in December-January. This is your most cost-effective content type. Create a monthly night-tour Reel series.', 'source_attribution', '{"reels_views": 15000, "inquiries_from_ig": 3, "cost_per_ig_inquiry": 150, "cost_per_google_inquiry": 325}', 'high', 'applied', '2026-01-20 08:00:00+00'),

  ('eeee1301-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', 'pricing', 'Reallocate $200/month from Google to Instagram', 'Google Ads CPI climbed 18% from January to March while Instagram CPI held steady. Shifting $200/month from Google to Instagram would improve overall cost efficiency without reducing total inquiry volume.', 'source_attribution', '{"google_cpi_jan": 190, "google_cpi_mar": 525, "ig_cpi_avg": 158, "suggested_shift": 200}', 'medium', 'pending', '2026-03-20 08:00:00+00'),

  ('eeee1301-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', 'engagement', 'Tour conversion decline needs investigation', 'Your tour conversion rate dropped from 50% to 25% over two months. While seasonal fluctuation is normal, a sustained decline warrants a tour experience audit. Shadow the next 2-3 tours and compare notes.', 'anomaly_alerts', '{"conversion_rate_prior": 0.50, "conversion_rate_current": 0.25, "months_declining": 2}', 'high', 'pending', '2026-03-22 08:00:00+00'),

  -- Rose Hill Gardens
  ('eeee1301-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', 'content', 'Garden wedding searches approaching annual peak', '"Garden wedding venue" searches in DC metro are at 75 and climbing. Your annual peak is typically April-May. Invest in professional spring garden photography now to have fresh content ready when searches peak.', 'google_trends', '{"term": "garden wedding venue", "current": 75, "typical_peak": 88, "peak_month": "April"}', 'high', 'pending', '2026-03-18 08:00:00+00'),

  ('eeee1301-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'engagement', 'Facebook outperforming expectations — increase budget', 'Facebook Ads produced 8 inquiries over 6 months at a $234 CPI, beating Google ($375 CPI) and approaching The Knot ($260 CPI) in cost efficiency. Your garden photos perform especially well in the Facebook feed format. Consider increasing Facebook budget by $100/month.', 'source_attribution', '{"fb_inquiries_6mo": 8, "fb_cpi": 234, "google_cpi": 375, "knot_cpi": 260}', 'medium', 'pending', '2026-03-15 08:00:00+00'),

  ('eeee1301-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', 'pricing', 'Address parking and restroom issues before spring', 'Two recent reviews cited parking difficulties and restroom quality. Your review average dropped from 4.6 to 3.8. These are operational issues with clear fixes: gravel the overflow lot ($2,000) and rent luxury restroom trailers for 150+ guest events ($500/event). The ROI is immediate — every 0.1 star increase correlates with a 3% improvement in inquiry conversion.', 'review_language', '{"score_before": 4.6, "score_after": 3.8, "issues": ["parking", "restrooms"], "gravel_cost": 2000, "trailer_cost_per_event": 500}', 'high', 'pending', '2026-02-15 08:00:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 12 recommendations


-- ============================================================
-- 14. CONSULTANT METRICS — performance over 6 months
-- ============================================================
-- Extends the 3 existing entries in seed.sql with October-December 2025

INSERT INTO consultant_metrics (id, venue_id, consultant_id, period_start, period_end, inquiries_handled, tours_booked, bookings_closed, conversion_rate, avg_response_time_minutes, avg_booking_value) VALUES
  -- Sarah Chen (Rixey) — Oct-Dec 2025
  ('eeee1401-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-10-01', '2025-10-31', 3, 2, 1, 0.33, 126, 17500),
  ('eeee1401-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-11-01', '2025-11-30', 4, 3, 2, 0.50, 105, 13150),
  ('eeee1401-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', '33333333-3333-3333-3333-333333333301', '2025-12-01', '2025-12-31', 2, 1, 0, 0.00, 510, 0),

  -- Jake Williams (Crestwood) — Oct-Dec 2025, Feb-Mar 2026
  ('eeee1401-0002-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2025-10-01', '2025-10-31', 2, 1, 0, 0.00, 180, 0),
  ('eeee1401-0002-0001-0001-000000000002', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2025-11-01', '2025-11-30', 3, 2, 0, 0.00, 145, 0),
  ('eeee1401-0002-0001-0001-000000000003', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2025-12-01', '2025-12-31', 1, 0, 0, 0.00, 90, 0),
  ('eeee1401-0002-0001-0001-000000000004', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2026-02-01', '2026-02-28', 7, 4, 1, 0.14, 98, 10200),
  ('eeee1401-0002-0001-0001-000000000005', '22222222-2222-2222-2222-222222222202', '33333333-3333-3333-3333-333333333302', '2026-03-01', '2026-03-27', 3, 1, 0, 0.00, 85, 0),

  -- Maya Patel (Glass House) — Oct-Dec 2025, Feb-Mar 2026
  ('eeee1401-0003-0001-0001-000000000001', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2025-10-01', '2025-10-31', 5, 3, 1, 0.20, 72, 18500),
  ('eeee1401-0003-0001-0001-000000000002', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2025-11-01', '2025-11-30', 6, 4, 2, 0.33, 65, 19250),
  ('eeee1401-0003-0001-0001-000000000003', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2025-12-01', '2025-12-31', 3, 2, 1, 0.33, 78, 15800),
  ('eeee1401-0003-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2026-02-01', '2026-02-28', 7, 4, 1, 0.14, 70, 16500),
  ('eeee1401-0003-0001-0001-000000000005', '22222222-2222-2222-2222-222222222203', '33333333-3333-3333-3333-333333333303', '2026-03-01', '2026-03-27', 5, 2, 0, 0.00, 75, 0),

  -- Olivia Ross (Rose Hill) — all 6 months
  ('eeee1401-0004-0001-0001-000000000001', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2025-10-01', '2025-10-31', 1, 0, 0, 0.00, 240, 0),
  ('eeee1401-0004-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2025-11-01', '2025-11-30', 3, 2, 1, 0.33, 130, 14500),
  ('eeee1401-0004-0001-0001-000000000003', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2025-12-01', '2025-12-31', 2, 1, 0, 0.00, 155, 0),
  ('eeee1401-0004-0001-0001-000000000004', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2026-01-01', '2026-01-31', 6, 3, 1, 0.17, 120, 11800),
  ('eeee1401-0004-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2026-02-01', '2026-02-28', 4, 2, 0, 0.00, 140, 0),
  ('eeee1401-0004-0001-0001-000000000006', '22222222-2222-2222-2222-222222222204', '33333333-3333-3333-3333-333333333304', '2026-03-01', '2026-03-27', 3, 1, 0, 0.00, 165, 0)
ON CONFLICT (id) DO NOTHING;
-- Total: 20 consultant metric entries


-- ============================================================
-- 15. DRAFT FEEDBACK — additional feedback entries
-- ============================================================
-- Links to the new drafts above

INSERT INTO draft_feedback (id, venue_id, draft_id, action, original_body, edited_body, rejection_reason, coordinator_edits, created_at) VALUES
  -- Jake rejected the too-formal Crestwood draft
  ('eeee1501-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222202', 'eeee1001-0001-0001-0001-000000000008', 'rejected', NULL, NULL, 'Way too formal — Sage would never say "Dear couple" or "Regards". Rewrite with the actual Crestwood voice.', NULL, '2026-03-19 09:10:00+00'),

  -- Olivia rejected the pushy Rose Hill draft
  ('eeee1501-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222204', 'eeee1001-0001-0001-0001-000000000009', 'rejected', NULL, NULL, 'Too pushy — we never say "dates are filling fast" or push for a deposit in the first email. That is not our vibe at all.', NULL, '2026-03-20 16:20:00+00'),

  -- Sarah approved catering reply with minor note
  ('eeee1501-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222201', 'eeee1001-0001-0001-0001-000000000005', 'approved', NULL, NULL, NULL, 'Good — Mountain Crust mention was a nice touch', '2026-03-18 11:00:00+00'),

  -- Maya approved the floor plan reply
  ('eeee1501-0001-0001-0001-000000000004', '22222222-2222-2222-2222-222222222203', 'eeee1001-0001-0001-0001-000000000007', 'approved', NULL, NULL, NULL, 'Perfect tone. Send.', '2026-03-21 16:15:00+00'),

  -- Olivia approved garden timing with minor edit
  ('eeee1501-0001-0001-0001-000000000005', '22222222-2222-2222-2222-222222222204', 'eeee1001-0001-0001-0001-000000000012', 'edited',
   'Hello lovely! Great question. In May, golden hour is around 7:15-7:45pm.',
   'Hello lovely! Great question. In May, golden hour hits around 7:15-7:45pm — it is the most magical time.',
   NULL, 'Made the golden hour line feel more personal', '2026-03-17 11:45:00+00')
ON CONFLICT (id) DO NOTHING;
-- Total: 5 feedback entries


-- ============================================================
-- DONE. Summary of what was seeded:
-- ============================================================
-- 1. search_trends:          72 rows (3 terms × 6 months × 4 venues)
-- 2. weather_data:           24 rows (6 months × 4 venues)
-- 3. economic_indicators:    24 rows (4 indicators × 6 months)
-- 4. anomaly_alerts:         12 rows (across all venues)
-- 5. ai_briefings:           28 rows (4 weekly + 6 monthly Rixey, 6 monthly × 3 others)
-- 6. review_language:        38 rows (8 + 10 + 10 + 10 across venues)
-- 7. source_attribution:     96 rows (4 sources × 6 months × 4 venues)
-- 8. marketing_spend:        63 rows (3 channels × 6 months × 4 venues)
-- 9. interactions:           25 rows (recent email threads)
-- 10. drafts:                12 rows (4 pending, 5 sent, 2 rejected, 1 auto-sent)
-- 11. engagement_events:     48 rows (across recent weddings)
-- 12. lead_score_history:    35 rows (journey snapshots)
-- 13. trend_recommendations: 12 rows (AI recommendations)
-- 14. consultant_metrics:    20 rows (performance data)
-- 15. draft_feedback:         5 rows (learning loop)
-- ============================================================
-- GRAND TOTAL: ~514 rows of intelligence data
-- ============================================================
