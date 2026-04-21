-- ============================================================================
-- Migration 066: Track how precise the wedding_date actually is
-- ============================================================================
--
-- CONTEXT
-- The classifier pulls wedding dates at varying specificity:
--   "June 14, 2026"  -> day precision
--   "June 2026"      -> month precision (we store 2026-06-01)
--   "Fall 2026"      -> season precision (we store 2026-10-01)
--   "2026"           -> year precision (we store 2026-01-01)
--
-- Storing all of these as the same shape in wedding_date loses the
-- distinction: the UI can't tell "Oct 1, 2026" (day-specific from the
-- couple) apart from "Fall 2026" (parsed down to Oct 1 as a convention).
-- This column tells the UI what to render. A null precision means a
-- human entered the date directly (trust as day-precision).
-- ============================================================================

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS wedding_date_precision text
  CHECK (wedding_date_precision IS NULL OR wedding_date_precision IN ('day', 'month', 'season', 'year'));

COMMENT ON COLUMN public.weddings.wedding_date_precision IS
  'How specific the classifier''s extracted date was. Null = day-precision (entered by a human or confidently parsed). Drives the wedding_date display format.';

NOTIFY pgrst, 'reload schema';
