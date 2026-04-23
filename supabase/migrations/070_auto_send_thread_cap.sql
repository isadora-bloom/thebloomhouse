-- ---------------------------------------------------------------------------
-- 070_auto_send_thread_cap.sql
-- ---------------------------------------------------------------------------
-- Phase 1 v4 Task 4 fix: add a per-Gmail-thread rolling-24h auto-send cap.
--
-- Why:
--   Today `auto_send_rules.daily_limit` is the only throughput gate. It is
--   venue-wide-per-context, so one Gmail thread with a couple's own
--   auto-responder can consume the entire cap in a loop (Sage auto-sends →
--   couple's auto-reply → Sage auto-sends again, up to daily_limit).
--
-- What:
--   `thread_cap_24h` caps auto-sends per Gmail thread within a rolling
--   24h window. Default 3 covers "Sage replied, lead bounced, Sage
--   replied once more with context" without allowing loops.
--
--   Enforcement query (in autonomous-sender.ts) joins drafts → interactions
--   on gmail_thread_id and counts auto_sent=true rows with
--   sent_at > now() - interval '24 hours'.
--
-- Multi-venue: per-venue column so Oakwood (conservative, cap=1) and Rixey
-- (accept cap=3) can diverge without code changes.
-- ---------------------------------------------------------------------------

ALTER TABLE public.auto_send_rules
  ADD COLUMN IF NOT EXISTS thread_cap_24h integer NOT NULL DEFAULT 3;

COMMENT ON COLUMN public.auto_send_rules.thread_cap_24h IS
  'Max auto-sends allowed on a single Gmail thread within a rolling 24h window. Belt-and-braces against auto-responder loops. Per-venue-per-context.';

NOTIFY pgrst, 'reload schema';
