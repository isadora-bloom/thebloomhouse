-- 421: the bar planner's own columns
--
-- Second half of what 420 found. The Bar Planner page writes four fields to
-- `bar_planning` and one to `bar_shopping_list` that are not columns, so those
-- statements have always failed:
--
--   bar_planning.event_duration_hours   the calculator's hours input
--   bar_planning.notes_calculator       the three tabs each keep their own note
--   bar_planning.notes_list
--   bar_planning.notes_recipes
--   bar_shopping_list.from_calculator   marks a row the calculator generated
--
-- Verified against production: bar_planning has bar_type, bartender_count,
-- guest_count, notes, selected_package_id, venue_id, wedding_id, and the
-- timestamps. bar_shopping_list has category, estimated_cost, item_name, notes,
-- purchased, quantity, unit and the scope columns. Nothing else.
--
-- Two consequences beyond the failed save. The notes auto-save carries
-- guest_count with it, so the whole statement failing means the guest count
-- never persisted either. And `from_calculator` is what "clear the calculator's
-- items" filters on: with no column the flag reads undefined on every row, the
-- filter matches nothing, and the button has never removed anything.
--
-- The existing `notes` column stays. The print page reads it, and the three
-- tab notes are a different thing from whatever is in there.

ALTER TABLE bar_planning
  ADD COLUMN IF NOT EXISTS event_duration_hours integer,
  ADD COLUMN IF NOT EXISTS notes_calculator     text,
  ADD COLUMN IF NOT EXISTS notes_list           text,
  ADD COLUMN IF NOT EXISTS notes_recipes        text;

COMMENT ON COLUMN bar_planning.notes_calculator IS
  'Free note on the Calculator tab. Separate from `notes`, which the print view reads.';

ALTER TABLE bar_shopping_list
  ADD COLUMN IF NOT EXISTS from_calculator boolean DEFAULT false;

COMMENT ON COLUMN bar_shopping_list.from_calculator IS
  'True for a row the calculator generated, so regenerating can replace just those and leave hand-added items alone.';

-- Rows that predate the column were all hand-added, since the calculator has
-- never managed to write one. Default false covers new rows; this covers the
-- existing ones rather than leaving them null, because the page treats the flag
-- as a boolean and null would make "clear generated items" skip them for a
-- second, different reason.
UPDATE bar_shopping_list SET from_calculator = false WHERE from_calculator IS NULL;
