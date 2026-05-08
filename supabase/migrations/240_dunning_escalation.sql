-- ============================================================================
-- 240_dunning_escalation.sql
-- D3 (2026-05-08). Dunning escalation ladder.
--
-- Stripe webhook (mig 209) already stamps past_due_since on first
-- past_due transition + fires payment_failed notifications. The
-- ladder beyond Day 7 (auto-retry window) ships in this commit:
--   Day 8: first reminder email
--   Day 14: second reminder email + in-app banner
--   Day 21: sage drafts paused (autonomous_paused)
--   Day 30: read-only mode
--
-- venues.dunning_stage tracks the LAST stage fired so the cron is
-- idempotent (it only escalates forward, never re-fires). Values:
--   NULL                    -- no past_due active
--   'reminder_1'            -- day 8 email sent
--   'reminder_2'            -- day 14 email + banner
--   'sage_paused'           -- day 21 enforcement
--   'read_only'             -- day 30 enforcement
--
-- venues.dunning_extension_until lets super_admin manually delay the
-- ladder for legitimate reasons (medical leave, etc.). When set + in
-- the future, the cron skips this venue entirely until the date passes.
-- ============================================================================

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS dunning_stage text;

ALTER TABLE public.venues
  ADD COLUMN IF NOT EXISTS dunning_extension_until timestamptz;

-- CHECK only on dunning_stage. NULL is the default (no escalation in flight).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
     WHERE constraint_schema = 'public'
       AND constraint_name = 'venues_dunning_stage_chk'
  ) THEN
    ALTER TABLE public.venues
      ADD CONSTRAINT venues_dunning_stage_chk
      CHECK (dunning_stage IS NULL OR dunning_stage IN ('reminder_1', 'reminder_2', 'sage_paused', 'read_only'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_venues_dunning_active
  ON public.venues (past_due_since)
  WHERE past_due_since IS NOT NULL;

COMMENT ON COLUMN public.venues.dunning_stage IS
  'Last dunning stage fired. NULL means no escalation in flight; cleared when subscription returns to active. Forward-only state machine driven by daily dunning_escalate cron.';

COMMENT ON COLUMN public.venues.dunning_extension_until IS
  'Optional super_admin override: skips dunning escalation until this timestamp. For legitimate billing-contact-unreachable cases.';
