-- ============================================================================
-- 275_calendar_unique_non_partial.sql
-- ============================================================================
-- Fix the external_calendar_refresh cron's 44/44 failure rate (caught
-- 2026-05-10 after Wave 8 health check fired the cron and surfaced
-- error 42P10: "there is no unique or exclusion constraint matching the
-- ON CONFLICT specification").
--
-- Migration 169 created a PARTIAL unique index on
-- (geo_scope, title, start_date) WHERE deleted_at IS NULL. Postgres
-- supports partial unique indexes as ON CONFLICT targets ONLY when the
-- INSERT statement repeats the same WHERE predicate. The Supabase
-- PostgREST upsert API does not pass that predicate — so every upsert
-- against the calendar table fails with 42P10.
--
-- Fix: drop the partial index, recreate as a plain (non-partial) unique
-- index. Soft-deleted rows (deleted_at IS NOT NULL) are now part of the
-- uniqueness constraint — meaning the cron's ON CONFLICT updates the
-- existing row instead of inserting a duplicate. Writer logic in
-- calendar-writer.ts can choose to un-delete (set deleted_at = NULL) on
-- conflict if needed, but for the cron-populated US federal holidays
-- this is the right shape.
--
-- Idempotent: DROP IF EXISTS, CREATE IF NOT EXISTS.
-- ============================================================================

DROP INDEX IF EXISTS public.uq_ece_scope_title_start;

CREATE UNIQUE INDEX IF NOT EXISTS uq_ece_scope_title_start
  ON public.external_calendar_events (geo_scope, title, start_date);

COMMENT ON INDEX public.uq_ece_scope_title_start IS
  '2026-05-10 — replaced the partial variant from migration 169. '
  'Partial unique indexes cannot be ON CONFLICT targets via PostgREST. '
  'Non-partial means soft-deleted rows participate in uniqueness; the '
  'cron writer should treat ON CONFLICT as un-delete-and-update rather '
  'than insert a duplicate.';

NOTIFY pgrst, 'reload schema';
