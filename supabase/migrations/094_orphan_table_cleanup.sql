-- ---------------------------------------------------------------------------
-- 094_orphan_table_cleanup.sql
-- ---------------------------------------------------------------------------
-- Audit fixes from the 2026-04-28 data-source pass.
--
-- 1. onboarding_progress shape mismatch
--    Page src/app/_couple-pages/getting-started/page.tsx reads a
--    single row per wedding shaped as five booleans + five
--    timestamps:
--      couple_photo_uploaded, first_message_sent, vendor_added,
--      inspo_uploaded, checklist_item_completed
--    The original 009 schema is multi-row keyed on a `step` enum.
--    Rather than refactor the page (which has typed state +
--    rendering around the denormalised shape), we add the wide
--    columns and treat the original `step`/`completed` columns as
--    vestigial. Existing data (none in production for any non-demo
--    venue) is folded into the new columns by step name.
--
-- 2. seating_assignments — pure dead schema
--    Migration 004 created seating_assignments as a junction
--    table (guest -> seating_table). No code in src/ reads or
--    writes it. The seating page uses guest_list.table_assignment_id
--    instead. seed.sql has 4 demo rows.
--    Drop the table; coordinators will need to re-seed if seating
--    assignments come back as a feature.
-- ---------------------------------------------------------------------------

-- ---- Part 1: onboarding_progress wide-column add ---------------------------

ALTER TABLE public.onboarding_progress
  ADD COLUMN IF NOT EXISTS couple_photo_uploaded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS couple_photo_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS first_message_sent boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS first_message_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS vendor_added boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS vendor_added_at timestamptz,
  ADD COLUMN IF NOT EXISTS inspo_uploaded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inspo_uploaded_at timestamptz,
  ADD COLUMN IF NOT EXISTS checklist_item_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS checklist_item_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- Fold any existing step-row data into the wide columns. For each
-- (wedding_id, step) row, mark the corresponding column true and
-- copy the timestamp. We aggregate per wedding so we end up with one
-- row per wedding even if the original shape had multiple rows.
DO $$
DECLARE
  r RECORD;
BEGIN
  -- Coalesce step rows into one wide row per wedding. We pick the
  -- earliest non-null venue_id for each wedding (in practice all
  -- rows for a wedding share venue_id).
  FOR r IN
    SELECT
      wedding_id,
      -- Pick any venue_id for this wedding — they'll all match since
      -- onboarding_progress is wedding-scoped. uuid has no MIN aggregate
      -- in stock Postgres so we cast to text and back.
      (array_agg(venue_id))[1] AS venue_id,
      bool_or(step = 'photo'     AND completed) AS couple_photo_uploaded,
      MAX(CASE WHEN step = 'photo'     AND completed THEN completed_at END) AS couple_photo_uploaded_at,
      bool_or(step = 'chat'      AND completed) AS first_message_sent,
      MAX(CASE WHEN step = 'chat'      AND completed THEN completed_at END) AS first_message_sent_at,
      bool_or(step = 'vendor'    AND completed) AS vendor_added,
      MAX(CASE WHEN step = 'vendor'    AND completed THEN completed_at END) AS vendor_added_at,
      bool_or(step = 'inspo'     AND completed) AS inspo_uploaded,
      MAX(CASE WHEN step = 'inspo'     AND completed THEN completed_at END) AS inspo_uploaded_at,
      bool_or(step = 'checklist' AND completed) AS checklist_item_completed,
      MAX(CASE WHEN step = 'checklist' AND completed THEN completed_at END) AS checklist_item_completed_at
    FROM public.onboarding_progress
    WHERE step IS NOT NULL
    GROUP BY wedding_id
  LOOP
    -- Update one canonical row per wedding (the earliest by created_at)
    -- with the rolled-up booleans. The remaining narrow rows stay in
    -- place harmlessly; readers select * and use only the wide cols.
    UPDATE public.onboarding_progress AS op
       SET couple_photo_uploaded        = COALESCE(r.couple_photo_uploaded, false),
           couple_photo_uploaded_at     = r.couple_photo_uploaded_at,
           first_message_sent           = COALESCE(r.first_message_sent, false),
           first_message_sent_at        = r.first_message_sent_at,
           vendor_added                 = COALESCE(r.vendor_added, false),
           vendor_added_at              = r.vendor_added_at,
           inspo_uploaded               = COALESCE(r.inspo_uploaded, false),
           inspo_uploaded_at            = r.inspo_uploaded_at,
           checklist_item_completed     = COALESCE(r.checklist_item_completed, false),
           checklist_item_completed_at  = r.checklist_item_completed_at,
           updated_at                   = now()
     WHERE op.wedding_id = r.wedding_id
       AND op.id = (
         SELECT id FROM public.onboarding_progress
          WHERE wedding_id = r.wedding_id
          ORDER BY created_at ASC LIMIT 1
       );
  END LOOP;
END $$;

-- One-row-per-wedding invariant for new writes. The page's read uses
-- maybeSingle(); without this constraint a coordinator could end up
-- with multiple rows per wedding from a misbehaving writer.
CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_progress_wedding_unique
  ON public.onboarding_progress (wedding_id)
  WHERE step IS NULL;

-- updated_at touch trigger so the writer can simply upsert without
-- having to set updated_at on every call.
CREATE OR REPLACE FUNCTION public.onboarding_progress_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_onboarding_progress_updated_at ON public.onboarding_progress;
CREATE TRIGGER trg_onboarding_progress_updated_at
  BEFORE UPDATE ON public.onboarding_progress
  FOR EACH ROW
  EXECUTE FUNCTION public.onboarding_progress_touch_updated_at();

NOTIFY pgrst, 'reload schema';

-- ---- Part 2: drop seating_assignments --------------------------------------
-- Pure dead schema in production. Zero readers in src/. The seating
-- page uses guest_list.table_assignment_id instead.

DROP TABLE IF EXISTS public.seating_assignments;

NOTIFY pgrst, 'reload schema';
