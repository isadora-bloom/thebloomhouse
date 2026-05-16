-- ---------------------------------------------------------------------------
-- 357_gmail_backfill_job_state.sql
-- ---------------------------------------------------------------------------
-- Historical Gmail backfill (2026-05-16).
--
-- A 12-month-plus inbox backfill is hours of work. Running it as a
-- browser loop is fragile — a laptop sleeping or a wifi blip kills it
-- and the resume cursor (in-memory React state) is lost. The job is now
-- a server-side background job: its state lives on the venues row and
-- the email_poll cron advances it one chunk every 5 minutes until done.
--
-- Columns:
--   gmail_backfill_status     null | pending | running | complete | error
--   gmail_backfill_phase      'general' (12-month inbox) | 'booked'
--                             (per-couple 3-year name+email search)
--   gmail_backfill_cursor     phase progress — week index, then couple index
--   gmail_backfill_emails     running count of messages imported
--   gmail_backfill_updated_at last touch; used to reclaim a dead 'running'
-- ---------------------------------------------------------------------------

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS gmail_backfill_status text
    CHECK (gmail_backfill_status IS NULL OR gmail_backfill_status IN
      ('pending', 'running', 'complete', 'error'));

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS gmail_backfill_phase text;

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS gmail_backfill_cursor integer NOT NULL DEFAULT 0;

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS gmail_backfill_emails integer NOT NULL DEFAULT 0;

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS gmail_backfill_updated_at timestamptz;

-- The cron scans for venues with a job in flight.
CREATE INDEX IF NOT EXISTS idx_venues_gmail_backfill_status
  ON public.venues (gmail_backfill_status)
  WHERE gmail_backfill_status IN ('pending', 'running');

NOTIFY pgrst, 'reload schema';
