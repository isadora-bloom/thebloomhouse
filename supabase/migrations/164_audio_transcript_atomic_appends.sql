-- Migration 158: atomic transcript append RPCs (T5-ι.2)
--
-- Pre-fix the audio-capture orchestrator did read-modify-write on
-- tours.transcript and tour_transcript_orphans.transcript:
--   1. SELECT existing transcript
--   2. JS concat with new segment text
--   3. UPDATE / upsert with the concatenated value
--
-- Two concurrent webhook calls for the same session — easy to hit
-- given OMI's per-segment streaming + multi-region deploys — would
-- each observe the pre-state, each compute their own concat, and
-- the later write clobbers the earlier one. The dropped text is
-- forensic record (transcript_segments inserts always succeed) but
-- the rolled-up tours.transcript / orphan.transcript that the
-- voice-learning + brief generators read is wrong.
--
-- This migration adds two SECURITY DEFINER functions that perform
-- the concat server-side in a single statement, so:
--   * append_tour_transcript: UPDATE ... SET transcript = COALESCE(transcript, '') || ' ' || $text
--   * upsert_orphan_transcript: INSERT ... ON CONFLICT (venue_id, session_id) DO UPDATE
--                                   SET transcript = orphans.transcript || ' ' || EXCLUDED.transcript
--
-- The unique index on (venue_id, session_id) in tour_transcript_orphans
-- (uq_tour_transcript_orphans_venue_session, from 122) is what gives
-- the upsert its serialization guarantee under contention.

-- =====================================================================
-- append_tour_transcript
-- =====================================================================
-- Appends $p_text to tours.transcript and bumps transcript_received_at.
-- venue_id is enforced in the WHERE clause as a defence-in-depth check
-- against a tour-id-only call (RLS already blocks cross-venue, but the
-- service-role caller bypasses RLS — keep the venue gate explicit).
--
-- Whitespace separator is a single space, matching the JS concat that
-- preceded this function. The leading space is suppressed when the
-- existing transcript is empty / NULL via COALESCE + the NULLIF
-- check on aggregate.

CREATE OR REPLACE FUNCTION public.append_tour_transcript(
  p_tour_id   uuid,
  p_venue_id  uuid,
  p_text      text,
  p_received_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_text IS NULL OR length(p_text) = 0 THEN
    RETURN;
  END IF;

  UPDATE public.tours
     SET transcript = CASE
                        WHEN transcript IS NULL OR length(transcript) = 0
                          THEN p_text
                        ELSE transcript || ' ' || p_text
                      END,
         transcript_received_at = p_received_at
   WHERE id = p_tour_id
     AND venue_id = p_venue_id;
END;
$$;

COMMENT ON FUNCTION public.append_tour_transcript IS
  'T5-ι.2. Atomic concat onto tours.transcript so concurrent OMI '
  'segment webhooks for the same session do not clobber each other. '
  'Server-side single-statement UPDATE replaces the prior SELECT → '
  'JS-concat → UPDATE pattern.';

GRANT EXECUTE ON FUNCTION public.append_tour_transcript(uuid, uuid, text, timestamptz)
  TO authenticated, service_role;

-- =====================================================================
-- upsert_orphan_transcript
-- =====================================================================
-- INSERT … ON CONFLICT DO UPDATE on (venue_id, session_id). Returns
-- the orphan row id. Increments segments_count atomically by the
-- delta the caller passes (so the caller doesn't need to re-read).
--
-- last_segment_at always advances (max of incoming + existing — the
-- incoming is current wall clock, so this is just a SET, but keep
-- the GREATEST to be safe against clock skew between web nodes).

CREATE OR REPLACE FUNCTION public.upsert_orphan_transcript(
  p_venue_id              uuid,
  p_session_id            text,
  p_audio_provider        text,
  p_text                  text,
  p_segments_count_delta  integer,
  p_last_segment_at       timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.tour_transcript_orphans (
    venue_id,
    session_id,
    audio_provider,
    transcript,
    segments_count,
    first_segment_at,
    last_segment_at,
    status
  ) VALUES (
    p_venue_id,
    p_session_id,
    p_audio_provider,
    COALESCE(p_text, ''),
    GREATEST(COALESCE(p_segments_count_delta, 0), 0),
    p_last_segment_at,
    p_last_segment_at,
    'pending'
  )
  ON CONFLICT (venue_id, session_id) DO UPDATE
     SET transcript     = CASE
                            WHEN tour_transcript_orphans.transcript IS NULL
                              OR length(tour_transcript_orphans.transcript) = 0
                              THEN COALESCE(EXCLUDED.transcript, '')
                            WHEN EXCLUDED.transcript IS NULL
                              OR length(EXCLUDED.transcript) = 0
                              THEN tour_transcript_orphans.transcript
                            ELSE tour_transcript_orphans.transcript || ' ' || EXCLUDED.transcript
                          END,
         segments_count = tour_transcript_orphans.segments_count
                          + GREATEST(COALESCE(p_segments_count_delta, 0), 0),
         last_segment_at = GREATEST(tour_transcript_orphans.last_segment_at,
                                    EXCLUDED.last_segment_at),
         audio_provider = COALESCE(tour_transcript_orphans.audio_provider,
                                   EXCLUDED.audio_provider)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_orphan_transcript IS
  'T5-ι.2. Atomic upsert-with-concat onto tour_transcript_orphans. '
  'Replaces the prior SELECT → JS-concat → upsert pattern that '
  'clobbered concurrent OMI webhook appends for the same session. '
  'Relies on the (venue_id, session_id) unique index from migration '
  '122 for serialization.';

GRANT EXECUTE ON FUNCTION public.upsert_orphan_transcript(uuid, text, text, text, integer, timestamptz)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
