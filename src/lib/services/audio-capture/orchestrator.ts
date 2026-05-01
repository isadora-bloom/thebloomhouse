/**
 * Audio-capture orchestrator (T2-E Phase 2 / ARCH-5.4).
 *
 * Provider-agnostic. Takes normalized segments from any
 * AudioCaptureAdapter and writes them to transcript_segments +
 * keeps the rolled-up tours.transcript / orphan.transcript text
 * aggregates in sync (dual-write during the cutover so existing
 * read paths — transcript-extract, post-tour-brief,
 * voice-learning — keep working untouched).
 *
 * Binding flow:
 *   1. session_id already bound to a tour          → segments anchor on tour
 *   2. session_id matches an existing orphan       → segments anchor on orphan
 *      (orphan_id) until coordinator promotes; then orphan-attach
 *      handler rewrites segment rows to tour_id.
 *   3. session_id is new + auto-match window match → bind to tour, segments
 *      anchor on tour.
 *   4. Otherwise                                   → mint orphan, segments
 *      anchor on orphan.
 *
 * The orchestrator is the only writer that knows about transcript_segments;
 * the route is a thin shim that authenticates, picks an adapter, and
 * hands off here.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedSegment } from './types'

export interface PersistResult {
  matchedTourId: string | null
  orphanId: string | null
  session: 'existing' | 'new_match' | 'orphan' | 'empty'
  segmentsWritten: number
}

export interface PersistArgs {
  supabase: SupabaseClient
  venueId: string
  sessionId: string
  audioProvider: string
  segments: NormalizedSegment[]
  /** Auto-match window in hours. Reads from venue_config.omi_match_window_hours
   *  (legacy name — kept for back-compat; renamed in a future migration). */
  autoMatchEnabled: boolean
  matchWindowHours: number
}

export async function persistAudioSegments(args: PersistArgs): Promise<PersistResult> {
  const {
    supabase, venueId, sessionId, audioProvider, segments,
    autoMatchEnabled, matchWindowHours,
  } = args

  if (segments.length === 0) {
    return { matchedTourId: null, orphanId: null, session: 'empty', segmentsWritten: 0 }
  }

  const nowIso = new Date().toISOString()
  const aggregateText = segments
    .map((s) => s.text)
    .filter((t) => t.length > 0)
    .join(' ')
    .trim()

  // ---------- 1. Already-bound session? ------------------------------------
  const { data: boundTour } = await supabase
    .from('tours')
    .select('id, transcript')
    .eq('venue_id', venueId)
    .eq('session_id', sessionId)
    .maybeSingle()

  if (boundTour?.id) {
    const tourId = boundTour.id as string
    const current = typeof boundTour.transcript === 'string' ? boundTour.transcript : ''
    const nextTranscript = current ? `${current} ${aggregateText}` : aggregateText

    await supabase
      .from('tours')
      .update({ transcript: nextTranscript, transcript_received_at: nowIso })
      .eq('id', tourId)
      .eq('venue_id', venueId)

    const written = await writeSegments(supabase, venueId, segments, sessionId, audioProvider, tourId, null)
    return { matchedTourId: tourId, orphanId: null, session: 'existing', segmentsWritten: written }
  }

  // ---------- 2. Auto-match to nearest pending/completed tour --------------
  if (autoMatchEnabled) {
    const nowMs = Date.now()
    const windowMs = matchWindowHours * 60 * 60 * 1000
    const lowerIso = new Date(nowMs - windowMs).toISOString()
    const upperIso = new Date(nowMs + windowMs).toISOString()

    const { data: candidates } = await supabase
      .from('tours')
      .select('id, scheduled_at, transcript')
      .eq('venue_id', venueId)
      .in('outcome', ['pending', 'completed'])
      .is('session_id', null)
      .gte('scheduled_at', lowerIso)
      .lte('scheduled_at', upperIso)

    const nearest = (candidates ?? [])
      .map((t) => ({
        id: t.id as string,
        transcript: typeof t.transcript === 'string' ? t.transcript : '',
        delta: Math.abs(new Date((t.scheduled_at as string) || nowIso).getTime() - nowMs),
      }))
      .sort((a, b) => a.delta - b.delta)[0]

    if (nearest) {
      const nextTranscript = nearest.transcript ? `${nearest.transcript} ${aggregateText}` : aggregateText
      await supabase
        .from('tours')
        .update({
          session_id: sessionId,
          audio_provider: audioProvider,
          transcript: nextTranscript,
          transcript_received_at: nowIso,
        })
        .eq('id', nearest.id)
        .eq('venue_id', venueId)

      const written = await writeSegments(supabase, venueId, segments, sessionId, audioProvider, nearest.id, null)
      return { matchedTourId: nearest.id, orphanId: null, session: 'new_match', segmentsWritten: written }
    }
  }

  // ---------- 3. Orphan it ------------------------------------------------
  const { data: existingOrphan } = await supabase
    .from('tour_transcript_orphans')
    .select('id, transcript, segments_count')
    .eq('venue_id', venueId)
    .eq('session_id', sessionId)
    .maybeSingle()

  const currentOrphanText = typeof existingOrphan?.transcript === 'string' ? existingOrphan.transcript : ''
  const currentCount = typeof existingOrphan?.segments_count === 'number' ? existingOrphan.segments_count : 0
  const nextOrphanText = currentOrphanText ? `${currentOrphanText} ${aggregateText}` : aggregateText

  const { data: orphan } = await supabase
    .from('tour_transcript_orphans')
    .upsert(
      {
        venue_id: venueId,
        session_id: sessionId,
        audio_provider: audioProvider,
        transcript: nextOrphanText,
        segments_count: currentCount + segments.length,
        last_segment_at: nowIso,
        status: 'pending',
      },
      { onConflict: 'venue_id,session_id' },
    )
    .select('id')
    .single()

  if (!orphan) {
    return { matchedTourId: null, orphanId: null, session: 'orphan', segmentsWritten: 0 }
  }

  const orphanId = orphan.id as string
  const written = await writeSegments(supabase, venueId, segments, sessionId, audioProvider, null, orphanId)
  return { matchedTourId: null, orphanId, session: 'orphan', segmentsWritten: written }
}

async function writeSegments(
  supabase: SupabaseClient,
  venueId: string,
  segments: NormalizedSegment[],
  sessionId: string,
  audioProvider: string,
  tourId: string | null,
  orphanId: string | null,
): Promise<number> {
  if (segments.length === 0) return 0
  const rows = segments.map((s) => ({
    venue_id: venueId,
    tour_id: tourId,
    orphan_id: orphanId,
    session_id: sessionId,
    audio_provider: audioProvider,
    speaker: s.speaker,
    speaker_normalised: s.speakerNormalised,
    is_user: s.isUser,
    start_ms: s.startMs,
    end_ms: s.endMs,
    text: s.text,
    metadata: s.metadata,
  }))
  const { error } = await supabase.from('transcript_segments').insert(rows)
  if (error) {
    // Don't throw — segment writes are forensic record but the
    // adapter's primary contract (tour transcript update) already
    // succeeded. Log + return 0.
    console.error('[audio-capture/orchestrator] segment insert failed:', error.message)
    return 0
  }
  return rows.length
}

/**
 * Promote an orphan to a tour: rewrite all transcript_segments rows
 * pointing at the orphan to point at the tour instead. Called from
 * the orphan-attach coordinator handler.
 */
export async function promoteOrphanSegments(
  supabase: SupabaseClient,
  orphanId: string,
  tourId: string,
): Promise<{ rewritten: number }> {
  const { error, count } = await supabase
    .from('transcript_segments')
    .update({ tour_id: tourId, orphan_id: null }, { count: 'exact' })
    .eq('orphan_id', orphanId)
  if (error) {
    console.error('[audio-capture/orchestrator] promote failed:', error.message)
    return { rewritten: 0 }
  }
  return { rewritten: count ?? 0 }
}
