-- Migration 207: admin_notifications.priority (GAP-02 / Stripe billing).
--
-- The Stripe webhook needs to surface payment failures + plan downgrades to
-- the coordinator dashboard. admin_notifications had no priority field, so
-- a critical billing event was visually identical to a routine info notice.
--
-- Adds a coarse priority enum + an indexed lookup so the notification feed
-- can sort/filter by urgency.
--
-- Idempotent.

ALTER TABLE public.admin_notifications
  ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'normal';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'admin_notifications_priority_check'
  ) THEN
    ALTER TABLE public.admin_notifications
      ADD CONSTRAINT admin_notifications_priority_check
        CHECK (priority IN ('low', 'normal', 'high', 'urgent'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_admin_notifications_priority
  ON public.admin_notifications(venue_id, priority, created_at DESC)
  WHERE priority IN ('high', 'urgent');

COMMENT ON COLUMN public.admin_notifications.priority IS
  'Severity used by the coordinator notification feed. high/urgent are '
  'eligible for email digests + dashboard banners. Default normal.';
