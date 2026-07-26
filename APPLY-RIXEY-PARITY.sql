-- ============================================================================
-- APPLY-RIXEY-PARITY.sql
-- Migrations from the Rixey→Bloom parity work. Run in the Supabase SQL editor
-- (or `supabase db push`) in order. Each block is also a numbered migration file
-- under supabase/migrations/ — this file is the convenience "paste it all" copy.
-- Safe to re-run: every statement is idempotent (IF EXISTS / IF NOT EXISTS).
-- ============================================================================

-- ---- 385: wedding_party save fixes -----------------------------------------
ALTER TABLE wedding_party
  ADD COLUMN IF NOT EXISTS blurb text;

ALTER TABLE wedding_party
  DROP CONSTRAINT IF EXISTS wedding_party_role_check;

COMMENT ON COLUMN wedding_party.blurb IS
  'Short blurb shown on the public wedding website (distinct from bio, the longer profile text).';

-- ---- 386: restore Rixey "worked here before?" vendor flag -------------------
-- (arrival_time / departure_time / instagram already exist from migration 032)
ALTER TABLE booked_vendors
  ADD COLUMN IF NOT EXISTS worked_here_before boolean;

COMMENT ON COLUMN booked_vendors.worked_here_before IS
  'Has this vendor worked at the venue before? true / null (unknown). Surfaced day-of so staff know who needs orienting.';
