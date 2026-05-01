-- Migration 129: transcript_segments table (T2-E Phase 2 / ARCH-5.4)
--
-- Pre-Phase-2 the OMI webhook concatenated all incoming text into a
-- single tours.transcript string and persisted only the running
-- aggregate. Per-segment metadata (speaker, is_user, start/end ms)
-- was discarded. That's wrong because:
--   1. Voice DNA learning wants speaker-segmented data — coordinator
--      vs visitor matter for tone analysis. A blob of "you you they
--      they" loses that.
--   2. Multi-provider future (Otter, AssemblyAI, Deepgram) returns
--      different shapes; a segment-level table normalizes them.
--   3. Forensic record per Constitution: every signal is preserved
--      with its source attribution. The current shape erases timing
--      and speaker after concatenation.
--
-- This migration adds transcript_segments. The OMI webhook (and
-- future iPhone-upload / Otter / etc. adapters) writes segment-level
-- rows here AND continues to update the running tours.transcript
-- aggregate during the cutover (dual-write).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS, RLS DROP/CREATE.

CREATE TABLE IF NOT EXISTS public.transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,

  -- Anchor: every segment must point at either a bound tour or an
  -- orphan row. Pre-binding segments live under orphan_id; once the
  -- coordinator (or auto-match) attaches the orphan to a tour, the
  -- adapter rewrites segment rows to point at the tour. Either-or
  -- enforced via CHECK below.
  tour_id uuid REFERENCES public.tours(id) ON DELETE CASCADE,
  orphan_id uuid REFERENCES public.tour_transcript_orphans(id) ON DELETE CASCADE,

  -- Audio capture provenance per Playbook ARCH-5.4 / migration 122.
  session_id text NOT NULL,
  audio_provider text NOT NULL DEFAULT 'omi',

  -- Per-segment fields. Shape mirrors OMI / Otter / Deepgram common
  -- denominator: speaker label + user/host flag + timing + text.
  -- speaker is free-text (provider may emit 'host', 'visitor',
  -- 'speaker_0', 'speaker_1', etc.); speaker_normalised is what
  -- voice-DNA + transcript-extract should read (mapped to
  -- 'host' / 'visitor' / 'unknown' by the adapter).
  speaker text,
  speaker_normalised text CHECK (
    speaker_normalised IS NULL
    OR speaker_normalised IN ('host', 'visitor', 'unknown')
  ),
  is_user boolean,

  -- Segment timing (offsets within the recording session, milliseconds).
  -- Some providers emit float seconds — the adapter rounds to int ms.
  start_ms integer,
  end_ms integer,

  text text NOT NULL,

  -- Free-form audit trail. Adapter dumps the raw provider segment
  -- shape here so a future debug tool can replay. Bounded by callers
  -- to keep row size sane.
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT segment_has_anchor CHECK (
    tour_id IS NOT NULL OR orphan_id IS NOT NULL
  ),
  CONSTRAINT segment_text_nonempty CHECK (length(trim(text)) > 0)
);

COMMENT ON TABLE public.transcript_segments IS
  'Segment-level rows from any audio-capture provider. Multiple '
  'segments per session_id; segments anchor on tour_id (bound) or '
  'orphan_id (pre-binding). audio_provider tags the source. '
  'tours.transcript is the rolled-up text aggregate kept in sync '
  'during cutover. Per Playbook ARCH-5.4 / T2-E Phase 2.';

COMMENT ON COLUMN public.transcript_segments.speaker_normalised IS
  'Adapter-mapped speaker role (host / visitor / unknown) derived '
  'from is_user + speaker. Voice-DNA learning + transcript-extract '
  'read this rather than the raw speaker label so multi-provider '
  'data is comparable.';

CREATE INDEX IF NOT EXISTS idx_transcript_segments_tour
  ON public.transcript_segments (tour_id, created_at)
  WHERE tour_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transcript_segments_orphan
  ON public.transcript_segments (orphan_id, created_at)
  WHERE orphan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transcript_segments_session
  ON public.transcript_segments (venue_id, session_id, created_at);

ALTER TABLE public.transcript_segments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "transcript_segments_select" ON public.transcript_segments;
CREATE POLICY "transcript_segments_select" ON public.transcript_segments
  FOR SELECT TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "transcript_segments_service" ON public.transcript_segments;
CREATE POLICY "transcript_segments_service" ON public.transcript_segments
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS "demo_anon_select_transcript_segments" ON public.transcript_segments;
CREATE POLICY "demo_anon_select_transcript_segments" ON public.transcript_segments
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));
