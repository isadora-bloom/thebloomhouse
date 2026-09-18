-- 420: the columns the rehearsal dinner page has always written
--
-- Found on 18 Sep while moving the couple portal's writes behind an API route.
-- `rehearsal_dinner` was created in migration 009 with nine data columns.
-- src/app/_couple-pages/rehearsal/page.tsx builds a payload of forty-one
-- fields, of which THIRTY-FOUR are not columns. Postgres rejects the whole
-- statement on the first unknown one, so every save that page has ever
-- attempted has failed. The couple fills the form in, presses save, and the
-- page sets its error state; nothing is stored.
--
-- Verified against production before writing this: the live table has
-- id, venue_id, wedding_id, location_name, address, date, start_time, end_time,
-- guest_count, menu_notes, special_arrangements, created_at. Nothing else.
-- No migration between 009 and 419 touches it.
--
-- Types are taken from the page's own RehearsalData interface rather than
-- guessed: `boolean` for the toggles, `integer` for the counts and money,
-- `time` for reservation_time to match start_time and end_time, text for the
-- rest. Every column is nullable, because the form is filled in over months and
-- the couple only ever completes the branch matching where they are eating.
--
-- location_name and address stay. The page does not write them, but the venue
-- side reads them, and dropping a column with rows in it to tidy the shape up
-- is not worth it.

ALTER TABLE rehearsal_dinner
  -- Common
  ADD COLUMN IF NOT EXISTS location_type        text,
  ADD COLUMN IF NOT EXISTS notes                text,

  -- At the venue
  ADD COLUMN IF NOT EXISTS venue_space          text,
  ADD COLUMN IF NOT EXISTS bar_type             text,
  ADD COLUMN IF NOT EXISTS food_type            text,
  ADD COLUMN IF NOT EXISTS food_notes           text,
  ADD COLUMN IF NOT EXISTS seating              text,
  ADD COLUMN IF NOT EXISTS table_layout         text,
  ADD COLUMN IF NOT EXISTS high_chairs          boolean,
  ADD COLUMN IF NOT EXISTS high_chair_count     integer,
  ADD COLUMN IF NOT EXISTS disposables          boolean,
  ADD COLUMN IF NOT EXISTS renting_china        boolean,
  ADD COLUMN IF NOT EXISTS renting_flatware     boolean,
  ADD COLUMN IF NOT EXISTS linens_source        text,
  ADD COLUMN IF NOT EXISTS decor_source         text,

  -- A restaurant
  ADD COLUMN IF NOT EXISTS restaurant_name      text,
  ADD COLUMN IF NOT EXISTS restaurant_address   text,
  ADD COLUMN IF NOT EXISTS restaurant_contact   text,
  ADD COLUMN IF NOT EXISTS restaurant_phone     text,
  ADD COLUMN IF NOT EXISTS reservation_time     time,
  ADD COLUMN IF NOT EXISTS private_dining       boolean,
  ADD COLUMN IF NOT EXISTS set_menu             boolean,
  ADD COLUMN IF NOT EXISTS dietary_notes        text,
  ADD COLUMN IF NOT EXISTS cost_per_person      integer,
  ADD COLUMN IF NOT EXISTS total_budget         integer,

  -- Somebody's house
  ADD COLUMN IF NOT EXISTS home_address         text,
  ADD COLUMN IF NOT EXISTS host_name            text,
  ADD COLUMN IF NOT EXISTS home_food_type       text,
  ADD COLUMN IF NOT EXISTS home_bar_type        text,
  ADD COLUMN IF NOT EXISTS setup_cleanup_plan   text,

  -- Somewhere else
  ADD COLUMN IF NOT EXISTS other_location_name  text,
  ADD COLUMN IF NOT EXISTS other_address        text,
  ADD COLUMN IF NOT EXISTS other_food_type      text,
  ADD COLUMN IF NOT EXISTS other_bar_type       text,

  -- Every other portal table has one and this never did. The page does not
  -- send it; the couple route will, once the page saves through it.
  ADD COLUMN IF NOT EXISTS updated_at           timestamptz DEFAULT now();

COMMENT ON COLUMN rehearsal_dinner.location_type IS
  'Which branch of the form applies: venue, restaurant, home, other. The other columns are only meaningful for the matching branch.';

-- One row per wedding. The page looks for an existing row and updates it, and
-- the configured couple route upserts on this, so without the constraint a
-- second save makes a second row and the page then reads whichever comes back
-- first. There is no duplicate to clean up first: every save so far failed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rehearsal_dinner_wedding_id
  ON rehearsal_dinner (wedding_id);

