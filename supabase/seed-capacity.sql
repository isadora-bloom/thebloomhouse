-- =====================================================================
-- seed-capacity.sql
-- Capacity & yield seed for the Crestwood Collection (2026 Saturdays)
--
-- Two parts:
--   A) booked_dates rows for each booked Saturday
--   B) venue_config.feature_flags.capacity_2026 with pre-computed stats
--
-- Definitions:
--   utilisation_pct     = booked_count / available_saturdays
--   yield_per_available = total_revenue / available_saturdays
--   yield_per_booked    = total_revenue / booked_count
--   avg_booking         = total_revenue / booked_count
--
-- All four venues have 42 available Saturdays in 2026 (portfolio rule:
-- 52 total Saturdays minus 10 off-season/holiday blackouts).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Part A: venue_availability (was booked_dates before migration 073)
-- ---------------------------------------------------------------------
-- Hawthorne Manor — 9 Saturdays, $238,500 total
-- Crestwood Farm  — 4 Saturdays,  $78,500 total
-- The Glass House — 4 Saturdays, $166,500 total
-- Rose Hill Gardens — 2 Saturdays, $30,500 total
--
-- Migration 073 renamed booked_dates -> venue_availability and replaced
-- the block_type column with a 5-state status enum. block_type='wedding'
-- maps to status='booked'.
-- ---------------------------------------------------------------------

INSERT INTO venue_availability (id, venue_id, date, wedding_id, status, notes)
VALUES
  -- Hawthorne Manor (venue 201)
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-04-18', NULL, 'booked', 'Hawthorne booked — $24,500'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-05-09', NULL, 'booked', 'Hawthorne booked — $22,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-06-13', NULL, 'booked', 'Hawthorne booked — $31,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-07-11', NULL, 'booked', 'Hawthorne booked — $28,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-08-22', NULL, 'booked', 'Hawthorne booked — $26,500'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-09-05', NULL, 'booked', 'Hawthorne booked — $29,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-10-10', NULL, 'booked', 'Hawthorne booked — $24,500'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-10-24', NULL, 'booked', 'Hawthorne booked — $31,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222201', '2026-11-07', NULL, 'booked', 'Hawthorne booked — $22,000'),

  -- Crestwood Farm (venue 202)
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', '2026-05-16', NULL, 'booked', 'Crestwood booked — $18,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', '2026-07-18', NULL, 'booked', 'Crestwood booked — $19,500'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', '2026-09-12', NULL, 'booked', 'Crestwood booked — $21,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222202', '2026-10-03', NULL, 'booked', 'Crestwood booked — $20,000'),

  -- The Glass House (venue 203)
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', '2026-03-28', NULL, 'booked', 'Glass House booked — $44,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', '2026-05-30', NULL, 'booked', 'Glass House booked — $42,000'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', '2026-08-15', NULL, 'booked', 'Glass House booked — $39,500'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222203', '2026-11-07', NULL, 'booked', 'Glass House booked — $41,000'),

  -- Rose Hill Gardens (venue 204)
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', '2026-06-27', NULL, 'booked', 'Rose Hill booked — $16,500'),
  (gen_random_uuid(), '22222222-2222-2222-2222-222222222204', '2026-08-08', NULL, 'booked', 'Rose Hill booked — $14,000')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------
-- Part B: venue_config.feature_flags.capacity_2026
-- ---------------------------------------------------------------------

-- Hawthorne Manor — 9 booked / 42 available
-- 238500 / 42 = 5678.57 → 5679
-- 238500 / 9  = 26500
UPDATE venue_config SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || jsonb_build_object(
  'capacity_2026', jsonb_build_object(
    'year', 2026,
    'available_saturdays', 42,
    'booked_count', 9,
    'utilisation_pct', 21.4,
    'total_revenue', 238500,
    'yield_per_available', 5679,
    'yield_per_booked', 26500,
    'avg_booking_value', 26500
  )
) WHERE venue_id = '22222222-2222-2222-2222-222222222201';

-- Crestwood Farm — 4 booked / 42 available
-- 78500 / 42 = 1869.05 → 1869
-- 78500 / 4  = 19625
UPDATE venue_config SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || jsonb_build_object(
  'capacity_2026', jsonb_build_object(
    'year', 2026,
    'available_saturdays', 42,
    'booked_count', 4,
    'utilisation_pct', 9.5,
    'total_revenue', 78500,
    'yield_per_available', 1869,
    'yield_per_booked', 19625,
    'avg_booking_value', 19625
  )
) WHERE venue_id = '22222222-2222-2222-2222-222222222202';

-- The Glass House — 4 booked / 42 available
-- 166500 / 42 = 3964.28 → 3964
-- 166500 / 4  = 41625
UPDATE venue_config SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || jsonb_build_object(
  'capacity_2026', jsonb_build_object(
    'year', 2026,
    'available_saturdays', 42,
    'booked_count', 4,
    'utilisation_pct', 9.5,
    'total_revenue', 166500,
    'yield_per_available', 3964,
    'yield_per_booked', 41625,
    'avg_booking_value', 41625
  )
) WHERE venue_id = '22222222-2222-2222-2222-222222222203';

-- Rose Hill Gardens — 2 booked / 42 available
-- 30500 / 42 = 726.19 → 726
-- 30500 / 2  = 15250
UPDATE venue_config SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || jsonb_build_object(
  'capacity_2026', jsonb_build_object(
    'year', 2026,
    'available_saturdays', 42,
    'booked_count', 2,
    'utilisation_pct', 4.8,
    'total_revenue', 30500,
    'yield_per_available', 726,
    'yield_per_booked', 15250,
    'avg_booking_value', 15250
  )
) WHERE venue_id = '22222222-2222-2222-2222-222222222204';
