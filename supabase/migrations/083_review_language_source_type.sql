-- ---------------------------------------------------------------------------
-- 083_review_language_source_type.sql
-- ---------------------------------------------------------------------------
-- Phase 7 Task 64: mine vocabulary from tour transcripts of couples who
-- booked and left 5-star reviews. Phrases land in review_language alongside
-- review-sourced phrases, so we need a column to tell them apart.
--
-- Mirrors the shape used on voice_preferences.source_type (migration 023),
-- but with a review-language-specific value set:
--   * 'review'     — extracted from a reviews row (existing rows, default)
--   * 'transcript' — mined from a tours.transcript row (Phase 7 Task 64)
--   * 'manual'     — coordinator typed the phrase directly (future)
--
-- source_reference is a free-form human-readable pointer — for transcripts
-- it's 'tour:<uuid>', for reviews we may backfill later as 'review:<uuid>'.
--
-- Default 'review' is safe: the only existing writer (extractReviewLanguage)
-- inserts from review text, and rows predating this migration all came
-- from reviews.
-- ---------------------------------------------------------------------------

ALTER TABLE public.review_language
  ADD COLUMN IF NOT EXISTS source_type text DEFAULT 'review'
    CHECK (source_type IN ('review', 'transcript', 'manual')),
  ADD COLUMN IF NOT EXISTS source_reference text;

COMMENT ON COLUMN public.review_language.source_type IS
  'Origin of the phrase. review = mined from reviews.body; transcript = mined from tours.transcript (Phase 7 Task 64, gated on booked+5-star); manual = coordinator typed directly.';

COMMENT ON COLUMN public.review_language.source_reference IS
  'Human-readable pointer to the source row, e.g. "tour:<uuid>" or "review:<uuid>". Null for manual entries.';

CREATE INDEX IF NOT EXISTS idx_review_language_source_type
  ON public.review_language (venue_id, source_type);

NOTIFY pgrst, 'reload schema';
