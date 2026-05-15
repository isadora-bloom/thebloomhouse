-- ---------------------------------------------------------------------------
-- 353_tracked_data_fields.sql
-- ---------------------------------------------------------------------------
-- "Surface what we couldn't place, and let the operator create a field
-- for it." Anchor: the silent-field-drop sweep.
--
-- Imports preserve every column in a raw jsonb (weddings.raw_import_row,
-- reviews.raw_import_row, marketing_spend.raw_import_row,
-- knowledge_base.raw_import_row — migrations 351 / 352). Nothing is
-- lost, but un-mapped columns are also invisible: they sit in jsonb
-- that no UI reads.
--
-- This migration adds two things:
--
--   1. tracked_data_fields — when the operator sees an un-homed column
--      on the data-fields surface and presses "Track this field", a
--      row lands here. It is a DEFINITION ("the key `Bar Package` in a
--      wedding's raw_import_row is meaningful — label it, type it,
--      surface it"). The VALUE is never copied — it stays in the
--      entity's raw jsonb and is read through this definition. No
--      value table, no double-write, no drift.
--
--   2. extra_fields jsonb on wedding_details + wedding_tables — the
--      couple-portal endpoints whitelist a fixed field list via
--      pick() and silently drop anything else with NO raw column.
--      extra_fields catches the leftovers so couple-submitted data is
--      never lost (the same raw-preservation pattern as imports).
--
-- NOT the same as wedding_detail_config.custom_fields: that array is
-- couple-portal FORM QUESTIONS the venue asks couples. tracked_data_fields
-- is about columns that arrived in IMPORTED data with no home. Distinct
-- domains, kept separate on purpose.
--
-- Rerun safety: CREATE TABLE / ADD COLUMN IF NOT EXISTS.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tracked_data_fields (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id        uuid NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  -- Which entity's raw jsonb this field is read from.
  entity_type     text NOT NULL CHECK (entity_type IN (
    'wedding','review','marketing_spend','knowledge_base',
    'wedding_details','wedding_tables'
  )),
  -- The key as it appears in the entity's raw jsonb
  -- (raw_import_row / extra_fields). Case-sensitive — matches the
  -- source export header verbatim.
  source_key      text NOT NULL,
  -- Operator-facing label. Defaults to an LLM suggestion the operator
  -- can edit at create time.
  label           text NOT NULL,
  data_type       text NOT NULL DEFAULT 'text'
                    CHECK (data_type IN ('text','number','money','date','boolean')),
  -- The LLM's read of what the column is, kept for audit / re-suggest.
  llm_suggestion  text,
  created_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tracked_data_fields IS
  'Operator-promoted fields: a column that arrived in imported data with '
  'no typed home. The value lives in the entity raw jsonb; this row is '
  'the definition that surfaces it. See migration 351/352 for the raw '
  'columns.';

-- One definition per (venue, entity, source_key) — pressing "Track"
-- twice is a no-op via ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tracked_data_fields_key
  ON tracked_data_fields (venue_id, entity_type, source_key);

ALTER TABLE tracked_data_fields ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tracked_data_fields_select" ON public.tracked_data_fields;
CREATE POLICY "tracked_data_fields_select" ON public.tracked_data_fields
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "tracked_data_fields_modify" ON public.tracked_data_fields;
CREATE POLICY "tracked_data_fields_modify" ON public.tracked_data_fields
  FOR ALL TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up
      WHERE up.id = auth.uid() AND up.venue_id IS NOT NULL
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
      WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "tracked_data_fields_service" ON public.tracked_data_fields;
CREATE POLICY "tracked_data_fields_service" ON public.tracked_data_fields
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ---------------------------------------------------------------------------
-- Couple-portal raw preservation — stop the pick() whitelist drop.
-- ---------------------------------------------------------------------------

ALTER TABLE public.wedding_details
  ADD COLUMN IF NOT EXISTS extra_fields jsonb;
COMMENT ON COLUMN public.wedding_details.extra_fields IS
  'Fields a couple submitted that are not on the wedding-details field '
  'whitelist. Caught here instead of silently dropped (the pick() drop).';

ALTER TABLE public.wedding_tables
  ADD COLUMN IF NOT EXISTS extra_fields jsonb;
COMMENT ON COLUMN public.wedding_tables.extra_fields IS
  'Fields a couple submitted that are not on the tables field whitelist. '
  'Caught here instead of silently dropped.';
