-- ---------------------------------------------------------------------------
-- 072_drafts_sent_at_and_venue_filter_trigger.sql
-- ---------------------------------------------------------------------------
-- Phase 1 close-out: two independent fixes surfaced by §6c acceptance tests.
--
-- Fix A — drafts.sent_at
--   autonomous-sender.ts:354 enforces the rolling-24h thread cap with
--   `.gte('sent_at', windowStart)`. The column was never created; the
--   enforcement silently returned PGRST204 ("column not in schema cache"),
--   getRecentThreadAutoSendCount swallowed the error and returned 0, and
--   the cap from migration 070 was dark. Adds the column, backfills from
--   approved_at for rows already marked auto_sent=true, and indexes the
--   (auto_sent, sent_at) predicate the service queries.
--
-- Fix B — default venue_email_filters on new venue insert
--   Migration 069 seeded calendly.com / honeybook.com / acuityscheduling.com
--   / dubsado.com into venue_email_filters for every venue that existed at
--   migration time (CROSS JOIN). Venues created AFTER the migration — via
--   onboarding, createTestVenue, or direct insert — had no filters. The
--   system-mail guard is venue-agnostic (these domains are always unsafe
--   for every venue), so the right fix is an AFTER INSERT trigger on venues
--   that seeds the same 4 rows per new venue.
-- ---------------------------------------------------------------------------

-- ============================================================================
-- Fix A — drafts.sent_at
-- ============================================================================

ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS sent_at timestamptz;

COMMENT ON COLUMN public.drafts.sent_at IS
  'Timestamp of actual Gmail send for auto-sent drafts. Set by flushPendingAutoSends + sendApprovedDraft on success. Queried by getRecentThreadAutoSendCount to enforce thread_cap_24h.';

-- Backfill rows already marked auto_sent=true. approved_at is the closest
-- proxy we have for "when did this actually go out" on historical rows.
UPDATE public.drafts
   SET sent_at = approved_at
 WHERE auto_sent = true
   AND sent_at IS NULL
   AND approved_at IS NOT NULL;

-- Index the enforcement predicate.
CREATE INDEX IF NOT EXISTS idx_drafts_auto_sent_sent_at
  ON public.drafts (venue_id, auto_sent, sent_at)
  WHERE auto_sent = true;

-- ============================================================================
-- Fix B — seed default filters on new venue insert
-- ============================================================================

CREATE OR REPLACE FUNCTION public.seed_default_venue_email_filters()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.venue_email_filters (venue_id, pattern_type, pattern, action, source, note)
  VALUES
    (NEW.id, 'sender_domain', 'calendly.com',         'ignore',   'manual', 'Calendly confirmation email — webhook is source of truth (seeded)'),
    (NEW.id, 'sender_domain', 'acuityscheduling.com', 'ignore',   'manual', 'Acuity Scheduling confirmation email (seeded)'),
    (NEW.id, 'sender_domain', 'honeybook.com',        'no_draft', 'manual', 'HoneyBook system mail — classify but do not draft (seeded)'),
    (NEW.id, 'sender_domain', 'dubsado.com',          'no_draft', 'manual', 'Dubsado system mail — classify but do not draft (seeded)')
  ON CONFLICT (venue_id, pattern_type, pattern) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seed_default_venue_email_filters ON public.venues;
CREATE TRIGGER trg_seed_default_venue_email_filters
  AFTER INSERT ON public.venues
  FOR EACH ROW
  EXECUTE FUNCTION public.seed_default_venue_email_filters();

COMMENT ON FUNCTION public.seed_default_venue_email_filters() IS
  'AFTER INSERT trigger on venues. Seeds the venue-agnostic scheduling/booking-tool filter domains per new venue. Mirror of the one-shot CROSS JOIN INSERT in migration 069; keeps new venues consistent with existing ones. Coordinators can delete any row they legitimately want to hear from (e.g. a venue that photographs its own HoneyBook invoices).';

NOTIFY pgrst, 'reload schema';
