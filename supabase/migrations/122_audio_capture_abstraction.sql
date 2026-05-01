-- Migration 122: audio-capture abstraction (OMI → provider-agnostic)
--
-- Per Playbook Part 5.4: every code path that consumes tour audio
-- reads from an audio-capture abstraction. OMI is one provider behind
-- the abstraction, not THE provider. Pre-migration the schema had
-- `omi_session_id` columns hardcoded on `tours` and
-- `tour_transcript_orphans` — adding iPhone audio upload, Deepgram,
-- Otter.ai, AssemblyAI as alternative providers required either
-- renaming the columns or faking OMI session IDs in non-OMI adapters.
--
-- This migration renames the columns and adds an `audio_provider`
-- discriminator. Downstream services (extract, brief, voice learning,
-- orphan triage UI) follow in the same commit.
--
-- Phase 1 of the audio-capture abstraction: schema is no longer single-
-- vendor-baked. Phase 2 (build orchestrator + adapter pattern + segment
-- table) is a separate follow-up — this migration unblocks it.
--
-- Idempotent: every step uses IF EXISTS / IF NOT EXISTS so re-running
-- against an already-migrated DB is a no-op.

-- =====================================================================
-- tours.omi_session_id → tours.session_id + audio_provider
-- =====================================================================

-- Add audio_provider with default='omi' (correct for all existing rows
-- since OMI is the only provider that's been writing).
ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS audio_provider text;

UPDATE public.tours
  SET audio_provider = 'omi'
  WHERE audio_provider IS NULL
    AND omi_session_id IS NOT NULL;

-- Rename omi_session_id → session_id. Atomic in Postgres.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tours'
      AND column_name = 'omi_session_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tours'
      AND column_name = 'session_id'
  ) THEN
    ALTER TABLE public.tours RENAME COLUMN omi_session_id TO session_id;
  END IF;
END $$;

-- Replace the partial index that referenced the old column name.
DROP INDEX IF EXISTS public.idx_tours_omi_session_id;
CREATE INDEX IF NOT EXISTS idx_tours_session_id
  ON public.tours (session_id)
  WHERE session_id IS NOT NULL;

COMMENT ON COLUMN public.tours.session_id IS
  'Audio-capture session ID. Provider-agnostic — see audio_provider '
  'for which adapter wrote the row. Pre-migration named omi_session_id; '
  'renamed in 122 per Playbook Part 5.4. Index is partial (only set '
  'when audio capture is bound to this tour).';

COMMENT ON COLUMN public.tours.audio_provider IS
  'Which audio-capture provider produced this tour transcript. '
  '''omi'' = OMI Dev Kit 2 wearable. Future values: ''iphone_upload'', '
  '''otter'', ''assemblyai'', ''deepgram''. NULL when no audio is bound '
  'to this tour. Per Playbook Part 5.4 adapter pattern.';

-- =====================================================================
-- tour_transcript_orphans.omi_session_id → session_id + audio_provider
-- =====================================================================

ALTER TABLE public.tour_transcript_orphans
  ADD COLUMN IF NOT EXISTS audio_provider text;

UPDATE public.tour_transcript_orphans
  SET audio_provider = 'omi'
  WHERE audio_provider IS NULL;

ALTER TABLE public.tour_transcript_orphans
  ALTER COLUMN audio_provider SET NOT NULL,
  ALTER COLUMN audio_provider SET DEFAULT 'omi';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tour_transcript_orphans'
      AND column_name = 'omi_session_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'tour_transcript_orphans'
      AND column_name = 'session_id'
  ) THEN
    ALTER TABLE public.tour_transcript_orphans RENAME COLUMN omi_session_id TO session_id;
  END IF;
END $$;

-- Replace the unique index on (venue_id, omi_session_id).
DROP INDEX IF EXISTS public.tour_transcript_orphans_venue_id_omi_session_id_idx;
DROP INDEX IF EXISTS public.uq_tour_transcript_orphans_venue_session;
CREATE UNIQUE INDEX IF NOT EXISTS uq_tour_transcript_orphans_venue_session
  ON public.tour_transcript_orphans (venue_id, session_id);

COMMENT ON COLUMN public.tour_transcript_orphans.session_id IS
  'Audio-capture session ID, same semantics as tours.session_id. '
  'Pre-migration named omi_session_id (renamed in 122).';

COMMENT ON COLUMN public.tour_transcript_orphans.audio_provider IS
  'Which audio-capture provider produced this orphan. Default ''omi'' '
  'for backward-compat with pre-122 rows. Per Playbook Part 5.4.';
