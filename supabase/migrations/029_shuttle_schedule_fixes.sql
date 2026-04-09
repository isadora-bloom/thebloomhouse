-- ============================================
-- 029: SHUTTLE SCHEDULE FIXES
-- ============================================
-- The transportation page (src/app/_couple-pages/transportation/page.tsx)
-- writes columns to shuttle_schedule that the 009 schema never defined:
--   - run_label          (replaces route_name; which was NOT NULL)
--   - pickup_time        (time-of-day, separate from departure_time)
--   - dropoff_time       (time-of-day)
--   - seat_count         (replaces capacity)
--   - shuttle_id         (shuttle letter: A, B, C...)
--   - sort_order         (display ordering)
--
-- Because route_name was NOT NULL, every generator insert silently failed
-- and the schedule appeared to "produce no output".
--
-- This migration:
--   1. Adds the new columns the app expects.
--   2. Makes route_name nullable (legacy column preserved).
--   3. Seeds shuttle_config on the demo venue so the autocomplete
--      suggestions have something to show.
-- ============================================

-- 1) Add new columns the transportation page inserts / reads
ALTER TABLE shuttle_schedule
  ADD COLUMN IF NOT EXISTS run_label text,
  ADD COLUMN IF NOT EXISTS pickup_time text,
  ADD COLUMN IF NOT EXISTS dropoff_time text,
  ADD COLUMN IF NOT EXISTS seat_count integer,
  ADD COLUMN IF NOT EXISTS shuttle_id text,
  ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;

-- 2) Make legacy route_name nullable so inserts that omit it don't fail
ALTER TABLE shuttle_schedule
  ALTER COLUMN route_name DROP NOT NULL;

-- 3) Seed shuttle_config on the Hawthorne Manor demo venue so
--    pickup autocomplete + fleet defaults work out of the box.
UPDATE venue_config
SET feature_flags = COALESCE(feature_flags, '{}'::jsonb) || jsonb_build_object(
  'shuttle_config', jsonb_build_object(
    'pickup_locations', jsonb_build_array(
      jsonb_build_object(
        'id', 'pl-hampton-inn',
        'name', 'Hampton Inn Charlottesville',
        'address', '2035 India Rd, Charlottesville, VA 22901',
        'transit_minutes', 25
      ),
      jsonb_build_object(
        'id', 'pl-marriott',
        'name', 'Marriott Downtown',
        'address', '235 W Main St, Charlottesville, VA 22902',
        'transit_minutes', 30
      )
    ),
    'default_transit_time', 25,
    'available_shuttles', 2,
    'seats_per_shuttle', 40,
    'shuttle_provider', 'Culpeper Shuttle Co',
    'provider_contact', '',
    'notes_to_couples', ''
  )
)
WHERE venue_id = '22222222-2222-2222-2222-222222222201';
