-- 422: the rest of the columns the couple portal has always written
--
-- Third and last batch from the 18 Sep sweep. 420 covered the rehearsal dinner,
-- 421 the bar planner, and this is everything else: nine columns across four
-- tables that their pages write, read, filter and render, and that the database
-- never had.
--
-- They share an origin. Every one of these is on the Rixey side, and most are in
-- that portal's own empty-string coercion list, so the parity port brought the
-- forms across and left some of the columns behind. The symptom is always the
-- same: Postgres rejects the statement on the first unknown column, so the save
-- fails whole, and on the read side the field comes back undefined and renders
-- blank. A couple could type into these for months.
--
-- Verified against production one table at a time before writing this. Types are
-- from each page's own interface, not guessed.

-- Allergies: the two follow-up questions on every record. The form has had them
-- since it was ported; neither has ever saved, which also means the whole
-- record failed, not just these fields.
ALTER TABLE allergy_registry
  ADD COLUMN IF NOT EXISTS caterer_alerted    boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS staying_overnight  boolean DEFAULT false;

-- Checklist: how an item came to be ticked. The page sends 'manual' when a
-- person ticks it, and null when they untick. Sage completing an item on a
-- couple's behalf is the case this exists to distinguish, so it is worth having
-- rather than dropping from the page.
ALTER TABLE checklist_items
  ADD COLUMN IF NOT EXISTS completed_via text;

COMMENT ON COLUMN checklist_items.completed_via IS
  'How the item was completed: manual when a person ticked it, or the name of whatever did it on their behalf. Null when not complete.';

-- Decor: the whole page is organised by space, and the space name was the one
-- thing it could not store. goes_home_with and leaving_it are the pair that
-- decide what happens to an item after the wedding, which is the question the
-- venue needs answered on the day.
ALTER TABLE decor_inventory
  ADD COLUMN IF NOT EXISTS space_name      text,
  ADD COLUMN IF NOT EXISTS goes_home_with  text,
  ADD COLUMN IF NOT EXISTS leaving_it      boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS sort_order      integer;

COMMENT ON COLUMN decor_inventory.leaving_it IS
  'The couple is leaving the item behind. When true, goes_home_with is meaningless and the page hides it.';

-- Guests: which side of the wedding a guest belongs to, and a free note. The
-- CSV import maps both a "group" and a "side" heading onto group_side, and the
-- guest list filters on it, so without the column the filter has been searching
-- a field that was never there.
--
-- `notes` is distinct from the existing `care_notes`: care_notes is the guest
-- care surface's, and this is the one on the guest's own row in the list.
ALTER TABLE guest_list
  ADD COLUMN IF NOT EXISTS group_side text,
  ADD COLUMN IF NOT EXISTS notes      text;

COMMENT ON COLUMN guest_list.notes IS
  'Free note on the guest, from the guest list. Separate from care_notes, which belongs to the guest care surface.';

-- Existing rows get the defaults rather than nulls, because the pages treat all
-- three as plain booleans and a null would make a tick box render unchecked for
-- a second, different reason.
UPDATE allergy_registry SET caterer_alerted = false WHERE caterer_alerted IS NULL;
UPDATE allergy_registry SET staying_overnight = false WHERE staying_overnight IS NULL;
UPDATE decor_inventory SET leaving_it = false WHERE leaving_it IS NULL;
