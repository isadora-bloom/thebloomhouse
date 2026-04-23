-- ---------------------------------------------------------------------------
-- 071_venue_config_onboarding_fields.sql
-- ---------------------------------------------------------------------------
-- Phase 1 v4 Task 8 fix: add the onboarding-captured configurables that
-- don't yet have a column to land in.
--
-- Why:
--   Task 8 audit (memory: bloom-onboarding-audit.md) flagged that onboarding
--   writes only 2 of 9 v4 configurables. The AI name, client-code prefix,
--   and ad-platform selection already have homes (`venue_ai_config.ai_name`,
--   `venue_config.venue_prefix` from migration 032, `auto_send_rules`).
--   `max_events_per_day` has no column yet — proper home is
--   `venue_availability.max_events` (Phase 2 Task 10), but per audit note:
--   "until then, store in `venue_config.max_events_per_day`".
--
--   When Phase 2 Task 10 ships, `venue_availability` per-date rows should
--   inherit this venue-level default on insert.
-- ---------------------------------------------------------------------------

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS max_events_per_day integer;

COMMENT ON COLUMN public.venue_config.max_events_per_day IS
  'Venue-level default for max simultaneous events in a single day. Onboarding captures this. When venue_availability lands (Phase 2 Task 10), per-date rows inherit this default on insert.';

-- ---------------------------------------------------------------------------
-- auto_send_rules needs a unique constraint on (venue_id, context, source)
-- so onboarding can upsert ad-platform seed rows idempotently. Without this,
-- re-running onboarding would duplicate rows and break getMatchingRule's
-- `.limit(1)` assumption.
--
-- Pre-existing dupes: seed.sql + the onboarding UI have both historically
-- written to this table without a conflict target, leaving a handful of
-- (venue, context, source) pairs with >1 row. Dedupe deterministically on
-- the lowest id per group before taking the lock, so the ALTER succeeds
-- against any real-world state.
-- ---------------------------------------------------------------------------
DELETE FROM public.auto_send_rules a
  USING (
    SELECT id FROM (
      SELECT id,
             ROW_NUMBER() OVER (PARTITION BY venue_id, context, source ORDER BY id) AS rn
        FROM public.auto_send_rules
    ) s
    WHERE s.rn > 1
  ) dupes
  WHERE a.id = dupes.id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auto_send_rules_venue_context_source_key'
  ) THEN
    ALTER TABLE public.auto_send_rules
      ADD CONSTRAINT auto_send_rules_venue_context_source_key
      UNIQUE (venue_id, context, source);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
