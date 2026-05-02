-- Migration 158: admin_notifications.user_id (T5-γ.3).
--
-- The essentials-suggester (T4-D / Playbook Part 20.5) needs to fire a
-- per-user notification: "you've dismissed 5+ Expanded cards on /pulse —
-- want to set /pulse to Recommended?". admin_notifications was venue-
-- scoped only, so we add an optional user_id so per-user notifications
-- can coexist with venue-broadcast ones.
--
-- Existing rows keep user_id NULL (venue-broadcast). Future writers can
-- target a specific coordinator by setting user_id.
--
-- Idempotent.

ALTER TABLE public.admin_notifications
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.user_profiles(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_admin_notifications_user_id
  ON public.admin_notifications(user_id)
  WHERE user_id IS NOT NULL;

COMMENT ON COLUMN public.admin_notifications.user_id IS
  'Target user for per-user notifications (T5-γ.3 essentials suggester, '
  'future per-user surfaces). NULL = venue-broadcast (legacy default). '
  'Coordinators see venue-broadcast notifs + their own user-targeted ones.';
