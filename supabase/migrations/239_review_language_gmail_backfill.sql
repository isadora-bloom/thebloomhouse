-- ============================================================================
-- 239_review_language_gmail_backfill.sql
-- B6 (2026-05-08). Voice DNA Gmail backfill source_type.
--
-- review_language.source_type CHECK (mig 083) admits {review, transcript,
-- manual}. The Gmail backfill produces phrases mined from a venue's
-- historical sent email. Add 'gmail_backfill' so those rows can carry a
-- distinct source tag and the /intel/voice-dna page can surface them
-- with the right "from email" badge.
-- ============================================================================

ALTER TABLE public.review_language
  DROP CONSTRAINT IF EXISTS review_language_source_type_check;

ALTER TABLE public.review_language
  ADD CONSTRAINT review_language_source_type_check
  CHECK (source_type IN ('review', 'transcript', 'manual', 'gmail_backfill'));

COMMENT ON CONSTRAINT review_language_source_type_check ON public.review_language IS
  'Allowed source_type values for review_language phrases. gmail_backfill added 2026-05-08 (B6) for the voice-DNA history-import flow.';
