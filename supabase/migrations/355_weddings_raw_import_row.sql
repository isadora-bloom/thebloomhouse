-- ---------------------------------------------------------------------------
-- 355_weddings_raw_import_row.sql
-- ---------------------------------------------------------------------------
-- Closes a silent-drop gap on the primary import path. Migration 352
-- added raw_import_row to reviews / knowledge_base / marketing_spend,
-- and migration 353 + the Data Fields page assume weddings carries the
-- same column — but it was never added to weddings.
--
-- Result today: a HoneyBook / CRM CSV column that has no alias AND no
-- typed weddings field is dropped, and /intel/data-fields shows
-- nothing for the 'wedding' entity (it reads weddings.raw_import_row).
--
-- This adds the column. The HoneyBook + generic-CSV adapters populate
-- it with the full header-keyed source row, so every column the venue
-- exported is preserved and surfaces on the Data Fields page for the
-- operator to track — same raw-preservation principle as the other
-- import tables.
--
-- Rerun safety: ADD COLUMN IF NOT EXISTS.
-- ---------------------------------------------------------------------------

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS raw_import_row jsonb;

COMMENT ON COLUMN public.weddings.raw_import_row IS
  'Full header-keyed source row from a CRM CSV import. Preserves every '
  'column the venue exported, including ones with no typed weddings '
  'field, so nothing drops silently and /intel/data-fields can surface '
  'them for the operator to track.';
