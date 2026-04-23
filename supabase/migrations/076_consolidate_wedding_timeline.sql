-- ---------------------------------------------------------------------------
-- 076_consolidate_wedding_timeline.sql
-- ---------------------------------------------------------------------------
-- Phase 2 Task 19: consolidate duplicate timeline tables.
--
-- Audit 2026-04-22:
--   * `timeline` (20 demo rows) — normalised per-item events with time,
--     title, category, location, etc. This is the canonical table,
--     consumed by 7+ files including sage-brain and the couple portal.
--   * `wedding_timeline` (1 demo row) — a 1-row-per-wedding summary table
--     with `ceremony_start`, `reception_end`, `timeline_data jsonb`, and
--     `notes`. Only two readers:
--       - transportation page reads ceremony_start + reception_end
--       - chat page counts rows (which is wrong — wedding_timeline is
--         1-per-wedding, not a list of events)
--     timeline_data was empty `{}` and notes was never written.
--
-- Consolidation:
--   * Add `ceremony_start time` + `reception_end time` to `weddings`.
--     These are per-wedding properties, not list items — they belong on
--     the parent row.
--   * Copy the one existing row's values into the parent wedding.
--   * Drop the wedding_timeline table. Callers migrate to:
--       - weddings.ceremony_start / reception_end (transportation)
--       - timeline table COUNT (chat page)
-- ---------------------------------------------------------------------------

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS ceremony_start time,
  ADD COLUMN IF NOT EXISTS reception_end time;

COMMENT ON COLUMN public.weddings.ceremony_start IS
  'Wall-clock ceremony start time for this wedding day (e.g. 16:30). Consolidated from wedding_timeline in migration 076.';
COMMENT ON COLUMN public.weddings.reception_end IS
  'Wall-clock reception end time for this wedding day (e.g. 23:00). Consolidated from wedding_timeline in migration 076.';

-- Migrate the one existing wedding_timeline row's values into the parent
-- wedding. If the table didn't exist yet (fresh install), this is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'wedding_timeline'
  ) THEN
    -- wedding_timeline stored ceremony_start / reception_end as text
    -- (e.g. "16:30"). Cast to time during the migration.
    UPDATE public.weddings AS w
       SET ceremony_start = NULLIF(wt.ceremony_start, '')::time,
           reception_end  = NULLIF(wt.reception_end, '')::time
      FROM public.wedding_timeline AS wt
     WHERE wt.wedding_id = w.id
       AND (w.ceremony_start IS NULL OR w.reception_end IS NULL);

    DROP TABLE public.wedding_timeline;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
