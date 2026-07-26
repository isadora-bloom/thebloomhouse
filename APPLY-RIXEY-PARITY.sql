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
