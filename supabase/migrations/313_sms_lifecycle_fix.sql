-- ============================================================================
-- 313 — SMS lifecycle fix
-- ============================================================================
-- Backstop migration for the SMS-only lead class. Real-world case: Justin &
-- Sandy (RM-1139) — 14 inbound SMS, heat=0, AI drafted a tour-invite when
-- the in-person tour already happened. Three root causes ship fixes in this
-- bundle; this migration adds the schema affordances they need.
--
--   1. Orphan engagement-event rebinder (service + daily cron). Rebinds
--      engagement_events.wedding_id from the interaction whose id sits in
--      metadata.interaction_id or metadata.openphone_message_id.
--
--   2. SMS scheduling-event extractor (Haiku). Reads last 30d of SMS for a
--      wedding and posts to tours when the thread evidences a confirmed or
--      completed visit. tours columns already exist (mig 009 + 196 + 306);
--      no schema needed for the extractor itself.
--
--   3. SMS-only Sage prompt awareness. Reads-only — uses counts from
--      interactions; no schema needed.
--
--   4. SMS routability guard primitive. No schema needed — pure function.
--
-- Per Wave-23 doctrine: statement-level idempotency, no BEGIN/COMMIT.

-- ----------------------------------------------------------------------------
-- Section 1: helper index for the orphan rebinder
-- ----------------------------------------------------------------------------
-- The rebinder fetches engagement_events with wedding_id IS NULL and a
-- non-null metadata.interaction_id (or metadata.openphone_message_id), then
-- joins through interactions. A partial index keyed on the orphan predicate
-- keeps the daily sweep cheap as the table grows — typical Rixey snapshot
-- has ~10s of orphans/day; a full table scan would be wasteful at
-- Wedgewood scale.

CREATE INDEX IF NOT EXISTS engagement_events_orphan_wedding_idx
  ON public.engagement_events (created_at)
  WHERE wedding_id IS NULL;

COMMENT ON INDEX public.engagement_events_orphan_wedding_idx IS
  'Partial index over rows the SMS orphan-rebinder reclaims. Daily cron job orphan_engagement_rebind walks this. 2026-05-12 / mig 313.';

-- ----------------------------------------------------------------------------
-- Section 2: tours.scheduled_at helper index for the SMS extractor
-- ----------------------------------------------------------------------------
-- The extractor idempotency check looks for an existing tour row within a
-- ±24h window of a proposed scheduled_at. Lookups are per (venue, wedding,
-- scheduled_at), so the existing PK doesn't help. Add a small composite.

CREATE INDEX IF NOT EXISTS tours_venue_wedding_scheduled_idx
  ON public.tours (venue_id, wedding_id, scheduled_at)
  WHERE wedding_id IS NOT NULL AND scheduled_at IS NOT NULL;

COMMENT ON INDEX public.tours_venue_wedding_scheduled_idx IS
  'Speeds the SMS scheduling-extractor idempotency window check (±24h around proposed scheduled_at). 2026-05-12 / mig 313.';

-- ----------------------------------------------------------------------------
-- Section 3: wedding-level SMS-extract bookkeeping
-- ----------------------------------------------------------------------------
-- Track when the extractor last ran on a wedding so a future drift refresh
-- can pace itself. Nullable — every existing row reads as "never run" until
-- the first ingest fires. Per the doctrine, every new column gets a comment.

ALTER TABLE public.weddings
  ADD COLUMN IF NOT EXISTS sms_scheduling_extracted_at timestamptz;

COMMENT ON COLUMN public.weddings.sms_scheduling_extracted_at IS
  'Last time the SMS scheduling-extractor (Haiku) processed this wedding. Stamped by extractTourSignalsFromSmsThread regardless of whether any tour row was created — used to throttle drift refreshes. 2026-05-12 / mig 313.';
