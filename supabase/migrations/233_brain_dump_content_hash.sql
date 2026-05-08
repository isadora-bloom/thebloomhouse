-- ============================================================================
-- 233_brain_dump_content_hash.sql
-- C-INGEST-3 (2026-05-08). Idempotency on re-upload.
--
-- Today: a coordinator who pastes the same CSV twice (or uploads the same
-- screenshot twice) gets two brain_dump_entries rows + two LLM
-- classifications + double-write of any candidate identities. That's
-- wasted Claude tokens and pollutes the audit trail.
--
-- Fix: hash the canonical input (rawText for text-only, file bytes for
-- attachments) on the API route before any LLM call. If the same
-- (venue_id, content_hash) was seen in the last 24h with parse_status
-- in ('parsed','confirmed','needs_clarification'), return the existing
-- entry instead of reprocessing.
--
-- Why 24h not forever:
--   - A coordinator legitimately re-uploads the same KB CSV after an
--     edit + reupload cycle elsewhere.
--   - A coordinator re-pastes the same observation a week later with
--     additional context — that's a new dump, not a dupe.
--   - Vision extraction quality improves over time as we tune prompts.
--     A re-run after a month is sometimes desirable.
--
-- The 24h window catches the accidental-double-click + bounce-back-from-
-- error-page cases without making the system feel stuck.
--
-- Idempotent (ALTER TABLE ... IF NOT EXISTS pattern via DO block).
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'brain_dump_entries'
       AND column_name = 'content_hash'
  ) THEN
    ALTER TABLE public.brain_dump_entries
      ADD COLUMN content_hash text;
  END IF;
END$$;

COMMENT ON COLUMN public.brain_dump_entries.content_hash IS
  'SHA-256 hex of canonical input (rawText for text-only, file bytes for attachments). Set by /api/brain-dump POST. NULL on rows pre-dating the C-INGEST-3 ship date (2026-05-08).';

-- Composite index supports the 24h dedup probe:
--   SELECT id FROM brain_dump_entries
--    WHERE venue_id = $1 AND content_hash = $2 AND created_at >= now() - interval '24 hours'
--   ORDER BY created_at DESC LIMIT 1
CREATE INDEX IF NOT EXISTS idx_brain_dump_entries_dedup
  ON public.brain_dump_entries (venue_id, content_hash, created_at DESC)
  WHERE content_hash IS NOT NULL;
