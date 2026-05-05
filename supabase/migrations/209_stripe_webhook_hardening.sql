-- Migration 209: Stripe webhook hardening (Phase 1 audit Fix 2).
--
-- BUG 1 fix: state-machine idempotency for stripe_events.
--   Adds processed_at TIMESTAMPTZ. The webhook handler:
--     1. INSERTs a row with processed_at = NULL (claim)
--     2. Runs all side-effects (venue update, notification write)
--     3. UPDATEs processed_at = now() only after side-effects succeed
--   On retry: if processed_at IS NOT NULL the event was fully processed —
--   return 200 immediately. If NULL, a prior run claimed the row but
--   crashed before finishing — fall through and re-run side-effects.
--   This closes the strand-venue-forever window where INSERT succeeded but
--   the venue UPDATE threw and the retry hit the unique constraint (23505)
--   and short-circuited before re-applying the tier change.
--
-- BUG 2 fix: structured dedup_key on admin_notifications.
--   Replaces the ILIKE body-scan dedup (sequential scan, brittle) with a
--   deterministic TEXT column + partial UNIQUE index on
--   (venue_id, type, dedup_key) WHERE dedup_key IS NOT NULL.
--   The webhook passes dedup_key = '<stripe_event_id>:<notif_type>' so
--   ON CONFLICT DO NOTHING handles all replays at the INSERT layer without
--   any read-before-write.
--
-- Idempotent (all DDL uses IF NOT EXISTS / IF EXISTS guards).

-- ─── stripe_events: add processed_at ────────────────────────────────────────

ALTER TABLE public.stripe_events
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;

COMMENT ON COLUMN public.stripe_events.processed_at IS
  'Set to now() only after ALL side-effects (venue update, notifications) '
  'have succeeded. NULL means the claim was inserted but processing is '
  'incomplete — retries MUST re-run side-effects. Non-NULL means the event '
  'is fully processed and retries MUST skip. State-machine guard added '
  'by migration 209 (Phase 1 audit Fix 2).';

-- Index for the retry check: WHERE stripe_event_id = $1 AND processed_at IS NOT NULL.
-- Using the primary key (id = stripe event id) so no extra index needed —
-- the PK lookup is already O(1). No new index required.

-- ─── admin_notifications: dedup_key column + partial UNIQUE index ────────────

ALTER TABLE public.admin_notifications
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

COMMENT ON COLUMN public.admin_notifications.dedup_key IS
  'Deterministic dedup token for this notification, typically '
  '<stripe_event_id>:<notif_type>. When non-NULL, the partial UNIQUE '
  'index on (venue_id, type, dedup_key) enforces exactly-once insertion '
  'via ON CONFLICT DO NOTHING — replacing the previous ILIKE body scan '
  '(migration 209, Phase 1 audit Fix 2).';

CREATE UNIQUE INDEX IF NOT EXISTS admin_notifications_venue_type_dedup
  ON public.admin_notifications(venue_id, type, dedup_key)
  WHERE dedup_key IS NOT NULL;

COMMENT ON INDEX public.admin_notifications_venue_type_dedup IS
  'Partial UNIQUE index used by the Stripe webhook to prevent duplicate '
  'coordinator notifications on replay. Only covers rows where dedup_key '
  'IS NOT NULL so normal (non-deduped) notifications are unaffected.';
