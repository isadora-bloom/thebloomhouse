-- ---------------------------------------------------------------------------
-- 099_interactions_search_indexes.sql
-- ---------------------------------------------------------------------------
-- Adds trigram GIN indexes on the columns the inbox search hits with
-- case-insensitive ILIKE: subject, body_preview, from_email, from_name.
--
-- Rationale: /agent/inbox now ships a search box that runs ILIKE %q% across
-- these columns. Without trigram indexes the planner falls back to a sequential
-- scan on interactions, which is fine at today's row count but becomes a
-- noticeable hit once a venue has a year of email history (tens of thousands
-- of rows per venue, and we filter across multiple venues at company scope).
--
-- pg_trgm is the right call here because:
--   - It accelerates ILIKE / LIKE with leading + trailing wildcards, which
--     standard btree indexes cannot do.
--   - It's already a Supabase-supported extension; no platform side-effects.
--   - We can later swap to tsvector/tsquery for a real full-text search
--     without touching these indexes.
--
-- All operations are idempotent so this migration is safe to re-run.
-- ---------------------------------------------------------------------------

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_interactions_subject_trgm
  ON public.interactions USING gin (subject gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_interactions_body_preview_trgm
  ON public.interactions USING gin (body_preview gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_interactions_from_email_trgm
  ON public.interactions USING gin (from_email gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_interactions_from_name_trgm
  ON public.interactions USING gin (from_name gin_trgm_ops);

NOTIFY pgrst, 'reload schema';
