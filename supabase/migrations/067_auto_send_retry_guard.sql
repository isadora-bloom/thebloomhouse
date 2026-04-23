-- ============================================================================
-- Migration 067: Auto-send status expansion + retry guard columns
-- ============================================================================
--
-- CONTEXT
-- The auto-send path in src/lib/services/email-pipeline.ts writes
--   drafts.status = 'auto_send_pending'
-- but the original CHECK in migration 002 only allows
--   ('pending', 'approved', 'rejected', 'sent').
-- Because the Supabase JS client does not throw on constraint failure
-- unless .throwOnError() is called (it isn't here), every auto-send
-- transition has been silently rejected. No draft has ever reached
-- flushPendingAutoSends() in a state that could send — auto-send has
-- been dark since launch.
--
-- This migration:
--   1) Expands the status CHECK to accept the auto-send states the app
--      already writes ('auto_send_pending'), plus two new states the
--      retry-guard fix needs:
--        - 'auto_send_sending' — claimed by a flush tick, in flight at Gmail
--        - 'auto_send_failed'  — max retries exhausted, coordinator alerted
--   2) Adds auto_send_attempts + auto_send_last_error for idempotency.
--
-- Expected side-effect on first deploy: any drafts that had notifications
-- created but were never transitioned will STILL be status='pending'.
-- flushPendingAutoSends marks their notifs as read and moves on (that
-- logic already handles status !== 'auto_send_pending'), so no cleanup
-- needed.
-- ============================================================================

ALTER TABLE drafts DROP CONSTRAINT IF EXISTS drafts_status_check;

ALTER TABLE drafts
  ADD CONSTRAINT drafts_status_check
  CHECK (status IN (
    'pending',
    'approved',
    'rejected',
    'sent',
    'auto_send_pending',
    'auto_send_sending',
    'auto_send_failed'
  ));

ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS auto_send_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE drafts
  ADD COLUMN IF NOT EXISTS auto_send_last_error text;

-- Partial index to make the flush query (all pending-ish auto-sends for
-- a venue) cheap once auto-send actually runs at scale.
CREATE INDEX IF NOT EXISTS idx_drafts_auto_send_pending
  ON drafts (venue_id, created_at)
  WHERE status IN ('auto_send_pending', 'auto_send_sending');
