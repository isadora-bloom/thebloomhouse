-- Migration 254: cultural_moments.archive_reason
--
-- TRENDS-DIAGNOSIS Fix 1 (2026-05-09). The /intel/cultural-moments
-- queue surfaced rows whose `end_at` was already in the past — moments
-- from June-October 2025 still showing in the "awaiting your decision"
-- bucket eight months later. Past moments cannot affect FUTURE bookings;
-- they're history. We auto-archive them via a daily sub-job folded into
-- the existing cultural_moments_auto_propose cron tick (no new Vercel
-- cron entry — we're at the 40-cron Pro plan limit).
--
-- This migration adds the audit-trail column so coordinators can see
-- WHY a row was archived. Possible values today:
--   - 'expired'           — end_at < now() at archive time. Safe to
--                           ignore; the moment ran its course.
--   - 'legacy_demo_seed'  — early demo seed rows that were never
--                           cleaned up; surfaced for production venues
--                           by mistake.
--   - NULL                — manually archived via UI or other path.
-- Future archive paths add new values without schema change.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.cultural_moments
  ADD COLUMN IF NOT EXISTS archive_reason text;

COMMENT ON COLUMN public.cultural_moments.archive_reason IS
  'Why a status=''archived'' row was archived. expired = end_at < now() '
  'at archive time (cron auto-archive). legacy_demo_seed = early demo '
  'data archived for non-demo venues. NULL = manually archived. '
  'Coordinator-visible audit trail; never null when the cron archives.';

-- Index for the daily expired-archive job. Filters to status='proposed'
-- because confirmed/dismissed rows must stay visible regardless of
-- end_at (a confirmed historical moment is a permanent attribution-
-- engine input). Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_cultural_moments_proposed_end_at
  ON public.cultural_moments (end_at)
  WHERE status = 'proposed';
