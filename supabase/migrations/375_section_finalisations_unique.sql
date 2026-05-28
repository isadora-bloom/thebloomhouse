-- ============================================================================
-- 372: SECTION_FINALISATIONS — unique(wedding_id, section_name)
--
-- 2026-05-26 audit fix. The original mig 009 has no unique constraint
-- on (wedding_id, section_name), so simultaneous tab edits (or a
-- racing insert) can create duplicate rows for the same section. The
-- couple-portal sidebar's MarkSectionCompleteBar guarded against this
-- on reads with order+limit(1), but the underlying schema should
-- enforce uniqueness so the duplicate state can't drift further.
--
-- Step 1 dedupes any existing dupes by keeping the row with the most
-- recent signoff timestamp (couple OR staff), falling back to
-- created_at. Step 2 adds the constraint. Idempotent — re-running
-- the migration after step 2 lands is a no-op.
-- ============================================================================

-- Step 1: dedupe. Keep one row per (wedding_id, section_name),
-- choosing the most recently touched. CTE ranks each duplicate set.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY wedding_id, section_name
      ORDER BY
        GREATEST(
          COALESCE(couple_signed_off_at, 'epoch'::timestamptz),
          COALESCE(staff_signed_off_at, 'epoch'::timestamptz),
          COALESCE(created_at, 'epoch'::timestamptz)
        ) DESC,
        id DESC
    ) AS rn
  FROM public.section_finalisations
)
DELETE FROM public.section_finalisations
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Step 2: add the constraint. IF NOT EXISTS guards re-runs.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'section_finalisations_wedding_section_unique'
  ) THEN
    ALTER TABLE public.section_finalisations
      ADD CONSTRAINT section_finalisations_wedding_section_unique
      UNIQUE (wedding_id, section_name);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
