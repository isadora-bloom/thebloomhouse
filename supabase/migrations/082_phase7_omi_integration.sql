-- ---------------------------------------------------------------------------
-- 082_phase7_omi_integration.sql
-- ---------------------------------------------------------------------------
-- Phase 7: Omi integration.
--
-- Goal: tour conversations are automatically transcribed (via Omi Dev Kit 2
-- wearable), uploaded to the correct venue's tour row, mined for extracted
-- intelligence (questions, attendee types, emotional signals), and fed into
-- the post-tour Sage brief + voice learning pipelines.
--
-- Design (ported from the Ground app's Omi integration pattern):
--   * Per-venue webhook token. Each venue configures one Omi token via
--     venue_config.omi_webhook_token; their coordinator pastes the webhook
--     URL (with ?token=...) into the Omi app's Developer Settings.
--   * Omi real-time transcripts fire per-segment. The edge function
--     verifies the token, then matches the session to the nearest scheduled
--     tour within a 6h window for that venue. Unmatched sessions stash in
--     tour_transcript_orphans for manual attach.
--   * tours.transcript already exists (Phase 2 Task 16). Add:
--     - transcript_received_at        (timestamptz)
--     - omi_session_id                (text, for cross-segment correlation)
--     - transcript_extracted          (jsonb, Task 62 AI-extracted fields)
--     - tour_brief_generated_at       (timestamptz, Task 63)
-- ---------------------------------------------------------------------------

-- ============================================================================
-- STEP 1 — venue_config Omi pairing fields
-- ============================================================================

ALTER TABLE public.venue_config
  ADD COLUMN IF NOT EXISTS omi_webhook_token text,
  ADD COLUMN IF NOT EXISTS omi_auto_match_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS omi_match_window_hours integer NOT NULL DEFAULT 6;

COMMENT ON COLUMN public.venue_config.omi_webhook_token IS
  'Phase 7. Per-venue Omi webhook token. Coordinators paste the URL https://<host>/api/omi/webhook?token=<this> into Omi Developer Settings. Null = Omi disabled for this venue.';
COMMENT ON COLUMN public.venue_config.omi_auto_match_enabled IS
  'Phase 7. When true, incoming segments auto-attach to the nearest scheduled tour within omi_match_window_hours. When false, every segment lands in tour_transcript_orphans for manual attach.';
COMMENT ON COLUMN public.venue_config.omi_match_window_hours IS
  'Phase 7. Time window around a scheduled tour during which Omi segments are matched to it. Default 6 hours.';

CREATE INDEX IF NOT EXISTS idx_venue_config_omi_token
  ON public.venue_config (omi_webhook_token)
  WHERE omi_webhook_token IS NOT NULL;

-- ============================================================================
-- STEP 2 — tours Omi-related columns
-- ============================================================================

ALTER TABLE public.tours
  ADD COLUMN IF NOT EXISTS omi_session_id text,
  ADD COLUMN IF NOT EXISTS transcript_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS transcript_extracted jsonb,
  ADD COLUMN IF NOT EXISTS tour_brief_generated_at timestamptz;

COMMENT ON COLUMN public.tours.omi_session_id IS
  'Phase 7. Omi session_id that this tour''s transcript was captured from. Lets the edge function append successive segments from the same session to the same tour.';
COMMENT ON COLUMN public.tours.transcript_extracted IS
  'Phase 7. AI-extracted intelligence from the transcript. Shape: {attendee_types[], key_questions[], emotional_signals[], specific_interests[], booked_date_mentions[], summary}. Written by src/lib/services/tour-transcript-extract.ts.';

-- Index for matching: "find the nearest pending tour for venue X whose
-- scheduled_at is within +/- N hours of now".
CREATE INDEX IF NOT EXISTS idx_tours_venue_scheduled
  ON public.tours (venue_id, scheduled_at)
  WHERE outcome IN ('pending', 'completed');

-- Index for session correlation (many segments, one session).
CREATE INDEX IF NOT EXISTS idx_tours_omi_session
  ON public.tours (omi_session_id)
  WHERE omi_session_id IS NOT NULL;

-- ============================================================================
-- STEP 3 — tour_transcript_orphans (for unmatched sessions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tour_transcript_orphans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  venue_id uuid NOT NULL REFERENCES public.venues(id) ON DELETE CASCADE,
  omi_session_id text NOT NULL,
  transcript text NOT NULL DEFAULT '',
  segments_count integer NOT NULL DEFAULT 0,
  first_segment_at timestamptz NOT NULL DEFAULT now(),
  last_segment_at timestamptz NOT NULL DEFAULT now(),
  -- Coordinator review surface:
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached', 'dismissed')),
  attached_to_tour_id uuid REFERENCES public.tours(id) ON DELETE SET NULL,
  attached_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tour_transcript_orphans_venue
  ON public.tour_transcript_orphans (venue_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tour_transcript_orphans_session
  ON public.tour_transcript_orphans (venue_id, omi_session_id);

COMMENT ON TABLE public.tour_transcript_orphans IS
  'owner:agent. Transcripts arriving via Omi that could not be auto-matched to a scheduled tour. Coordinators triage these at /agent/omi-inbox and attach to a tour or dismiss.';

ALTER TABLE public.tour_transcript_orphans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tour_transcript_orphans_select" ON public.tour_transcript_orphans;
CREATE POLICY "tour_transcript_orphans_select" ON public.tour_transcript_orphans
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

DROP POLICY IF EXISTS "tour_transcript_orphans_update" ON public.tour_transcript_orphans;
CREATE POLICY "tour_transcript_orphans_update" ON public.tour_transcript_orphans
  FOR UPDATE TO authenticated
  USING (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  )
  WITH CHECK (
    venue_id IN (
      SELECT up.venue_id FROM public.user_profiles up WHERE up.id = auth.uid()
      UNION
      SELECT v.id FROM public.venues v
        JOIN public.user_profiles up ON up.org_id = v.org_id
       WHERE up.id = auth.uid()
    )
    OR public.is_super_admin()
  );

DROP POLICY IF EXISTS "demo_anon_select" ON public.tour_transcript_orphans;
CREATE POLICY "demo_anon_select" ON public.tour_transcript_orphans
  FOR SELECT TO anon
  USING (venue_id IN (SELECT id FROM public.venues WHERE is_demo = true));

-- ============================================================================
-- STEP 4 — updated_at trigger on tour_transcript_orphans
-- ============================================================================

CREATE OR REPLACE FUNCTION public.tour_transcript_orphans_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tour_transcript_orphans_updated_at ON public.tour_transcript_orphans;
CREATE TRIGGER trg_tour_transcript_orphans_updated_at
  BEFORE UPDATE ON public.tour_transcript_orphans
  FOR EACH ROW
  EXECUTE FUNCTION public.tour_transcript_orphans_touch_updated_at();

NOTIFY pgrst, 'reload schema';
