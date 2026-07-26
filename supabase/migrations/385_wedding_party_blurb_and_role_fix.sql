-- 385: wedding_party save fixes
--
-- Two bugs made every wedding-party add/edit fail:
--
-- 1. party/page.tsx writes a `blurb` field (short text shown on the couple's
--    wedding website, distinct from the longer `bio`). The column never existed,
--    so PostgREST rejected every insert/update with "column blurb does not exist".
--
-- 2. The table kept an inline CHECK from migration 009 limiting `role` to
--    ('maid_of_honor','best_man','bridesmaid','groomsman','flower_girl',
--    'ring_bearer','other'). The app's role list is far wider (honor_attendant,
--    best_person, attendant, flower_child, grandparent, pet, ...) plus free-text
--    custom roles via the "Other" option. Every role outside the seven-value list
--    violated the constraint. The application layer owns this taxonomy now, so the
--    DB-level enumeration is dropped rather than widened (it cannot enumerate the
--    free-text custom roles regardless).

ALTER TABLE wedding_party
  ADD COLUMN IF NOT EXISTS blurb text;

ALTER TABLE wedding_party
  DROP CONSTRAINT IF EXISTS wedding_party_role_check;

COMMENT ON COLUMN wedding_party.blurb IS
  'Short blurb shown on the public wedding website (distinct from bio, the longer profile text).';
