-- 390: restore Rixey wedding-details fields dropped in Bloom
--
-- Parents + "have we met them?", the "Per Current Contract" reference block
-- (check-in/out, max + actual rehearsal/wedding hours, overnights), plus dog
-- sitter, high chairs and wedding-party count. All couple-editable text/number
-- fields the venue relies on for day-of coordination.

ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS partner1_parents text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS partner1_parents_met boolean;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS partner2_parents text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS partner2_parents_met boolean;

ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_checkin text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_checkout text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_max_rehearsal integer;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_max_wedding integer;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_overnights integer;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_rehearsal_hours text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS contract_wedding_hours text;

ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS dog_sitter_name text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS dog_sitter_time text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS high_chairs text;
ALTER TABLE wedding_details ADD COLUMN IF NOT EXISTS wedding_party_count text;
