-- ---------------------------------------------------------------------------
-- 171_voice_dna_last_refresh.sql
-- ---------------------------------------------------------------------------
-- T5-followup-X (2026-05-02). Voice-DNA monthly refresh.
--
-- Stream S built voice-dna-extract.ts as a one-shot Day-4 onboarding step.
-- As new outbound emails accumulate over the months that follow, the seed
-- becomes stale: a coordinator who hires a new staff member, changes
-- signoff style, or shifts greeting register won't see those updates
-- propagate to the AI personality engine until they manually re-run the
-- extraction with overwrite=true (which nukes the seed).
--
-- The monthly refresh cron runs the extractor in INCREMENTAL mode against
-- only the last 30 days of NEW outbound emails (since the previous
-- refresh) and INSERTS new patterns / increments frequencies on existing
-- ones, never deleting seed rows.
--
-- Per-venue tracking lives on venue_ai_config (which already has the
-- venue_id UNIQUE constraint we need). One column, nullable — NULL =
-- "never refreshed since seed; use seed time as the lower bound".
--
-- Idempotent: ADD COLUMN IF NOT EXISTS.

ALTER TABLE public.venue_ai_config
  ADD COLUMN IF NOT EXISTS voice_dna_last_refresh_at timestamptz;

COMMENT ON COLUMN public.venue_ai_config.voice_dna_last_refresh_at IS
  'T5-followup-X (2026-05-02). Last time the monthly voice-DNA refresh '
  'cron ran for this venue. NULL on venues that have only been seeded '
  '(or never seeded at all). The refresh path uses this as the lower '
  'bound for sampling new outbound emails — only emails created after '
  'this timestamp feed the incremental extraction. Updated by the '
  'voice_dna_refresh cron (vercel.json: 0 6 1 * *).';

NOTIFY pgrst, 'reload schema';
