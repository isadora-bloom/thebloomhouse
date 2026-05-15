-- ---------------------------------------------------------------------------
-- 352_import_raw_row_preservation.sql
-- ---------------------------------------------------------------------------
-- Silent-field-drop sweep. An audit of every upload path found three
-- importers that map a fixed subset of columns and discard the rest
-- with no record:
--
--   reviews          -- importReviews keeps 6 fields; a CSV with a
--                       response column, verified flag, language, etc.
--                       loses them silently.
--   knowledge_base   -- the brain-dump KB import keeps question /
--                       answer / category; any other column drops.
--   marketing_spend  -- parseSpendCsv keeps source / month / amount /
--                       campaign; impressions, clicks, channel notes
--                       drop.
--
-- The cure is the pattern the platform-signals importer already uses
-- (extracted_identity.raw_row) and crm_import_rows.row_data: keep the
-- ENTIRE source row in a jsonb column so nothing the operator uploaded
-- is ever truly lost, even when it has no typed column.
--
-- This migration adds `raw_import_row jsonb` to the three tables. The
-- importers populate it (TypeScript change, same release).
--
-- Rerun safety: ADD COLUMN IF NOT EXISTS.
-- ---------------------------------------------------------------------------

ALTER TABLE public.reviews
  ADD COLUMN IF NOT EXISTS raw_import_row jsonb;
COMMENT ON COLUMN public.reviews.raw_import_row IS
  'The full source row from a CSV / paste import, header-keyed. Lets a '
  'later re-import recover any column Bloom did not map to a typed field.';

ALTER TABLE public.knowledge_base
  ADD COLUMN IF NOT EXISTS raw_import_row jsonb;
COMMENT ON COLUMN public.knowledge_base.raw_import_row IS
  'Full source row from a CSV import, header-keyed. Audit + re-import '
  'safety for columns beyond question / answer / category.';

ALTER TABLE public.marketing_spend
  ADD COLUMN IF NOT EXISTS raw_import_row jsonb;
COMMENT ON COLUMN public.marketing_spend.raw_import_row IS
  'Full source row from a spend CSV, header-keyed. Preserves columns '
  'beyond source / month / amount / campaign (impressions, clicks...).';
