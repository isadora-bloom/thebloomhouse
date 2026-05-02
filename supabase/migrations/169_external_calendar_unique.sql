-- Migration 169: external_calendar_events writer support (T5-followup)
--
-- Stream T's cron-coverage audit (T5-ε.3) flagged external_calendar_events
-- as having ZERO writers anywhere in src / supabase functions / scripts.
-- Reader (lib/services/external-context/calendar.ts) feeds the
-- correlation engine's calendar channel, plus intel-brain.ts gathers it
-- as venue context — both surfaces sit permanently empty without a
-- writer. Stream V adds a daily idempotent cron driven by
-- populateUSCalendarEvents() in src/lib/services/external-context/
-- calendar-writer.ts. This migration adds the schema bits the writer
-- needs:
--
--   1. Unique index on (geo_scope, title, start_date) so the cron's
--      ON CONFLICT upsert is well-defined. Without this, repeated cron
--      runs would duplicate every federal holiday daily.
--
--   2. created_by_writer text column so we can later distinguish
--      cron-populated rows ('cron:external_calendar_refresh') from
--      coordinator-curated rows ('coordinator:<user_id>'). The Stream V
--      cron stamps 'cron:external_calendar_refresh' on every upsert —
--      future coordinator UI for venue-specific events (a local town
--      festival, a regional bridal expo) will stamp the user id, and
--      the cron's upsert MUST NOT overwrite coordinator rows. Strict
--      separation deferred until the curator UI exists; for now the
--      column just records provenance.
--
-- Idempotent: CREATE UNIQUE INDEX IF NOT EXISTS, ADD COLUMN IF NOT EXISTS.

-- 1. Unique index for upsert target
CREATE UNIQUE INDEX IF NOT EXISTS uq_ece_scope_title_start
  ON public.external_calendar_events (geo_scope, title, start_date)
  WHERE deleted_at IS NULL;

-- 2. Provenance column
ALTER TABLE public.external_calendar_events
  ADD COLUMN IF NOT EXISTS created_by_writer text DEFAULT 'manual';

COMMENT ON COLUMN public.external_calendar_events.created_by_writer IS
  'Provenance tag distinguishing cron-populated rows from coordinator '
  'curation. Cron stamps ''cron:external_calendar_refresh''; future '
  'coordinator UI will stamp ''coordinator:<user_id>''. The cron upsert '
  'should not overwrite coordinator rows once that UI ships.';
