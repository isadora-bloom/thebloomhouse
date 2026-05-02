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
    .select('id')
    .eq('venue_id', venueId)
    .eq('session_id', sessionId)
    .maybeSingle()

  if (boundTour?.id) {
    const tourId = boundTour.id as string
    // Atomic concurrent-append (T5-ι.2). Pre-fix: SELECT existing
    // transcript → JS concat → UPDATE. Two webhook calls hitting
    // the same session ms-apart would each read the pre-state, then
    // each write their own concat — clobbering whichever one ran
    // last. Post-fix: server-side concat via Postgres RPC so the
    // append is a single statement and the row-level lock that
    // backs the UPDATE serializes the two appends.
    const { error: appendErr } = await supabase.rpc('append_tour_transcript', {
      p_tour_id: tourId,
      p_venue_id: venueId,
      p_text: aggregateText,
      p_received_at: nowIso,
    })
    if (appendErr) {
      console.error('[audio-capture/orchestrator] append_tour_transcript failed:', appendErr.message)
    }

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
      .select('id, scheduled_at')
      .eq('venue_id', venueId)
      .in('outcome', ['pending', 'completed'])
      .is('session_id', null)
      .gte('scheduled_at', lowerIso)
      .lte('scheduled_at', upperIso)

    // Only id + scheduled_at — the transcript is updated server-side
    // via append_tour_transcript so we don't need the existing value.
    const nearest = (candidates ?? [])
      .map((t) => ({
        id: t.id as string,
        delta: Math.abs(new Date((t.scheduled_at as string) || nowIso).getTime() - nowMs),
      }))
      .sort((a, b) => a.delta - b.delta)[0]

    if (nearest) {
      // Bind the session_id + audio_provider first (one-shot UPDATE
      // — these are write-once per row), then atomically append text.
      // Splitting the UPDATE keeps the append idempotent across
      // concurrent webhook calls that race onto the same nearest
      // tour after a binding-race retry.
      await supabase
        .from('tours')
        .update({
          session_id: sessionId,
          audio_provider: audioProvider,
        })
        .eq('id', nearest.id)
        .eq('venue_id', venueId)

      const { error: appendErr } = await supabase.rpc('append_tour_transcript', {
        p_tour_id: nearest.id,
        p_venue_id: venueId,
        p_text: aggregateText,
        p_received_at: nowIso,
      })
      if (appendErr) {
        console.error('[audio-capture/orchestrator] append_tour_transcript (new_match) failed:', appendErr.message)
      }

      const written = await writeSegments(supabase, venueId, segments, sessionId, audioProvider, nearest.id, null)
      return { matchedTourId: nearest.id, orphanId: null, session: 'new_match', segmentsWritten: written }
    }
  }

  // ---------- 3. Orphan it ------------------------------------------------
  // Atomic upsert-with-concat (T5-ι.2). Pre-fix: SELECT existing →
  // JS concat → upsert. Two concurrent webhook calls for the same
  // (venue_id, session_id) would each read the pre-state and each
  // write their own concat, with the second write clobbering the
  // first. Post-fix: a single SQL statement performs the
  // INSERT ... ON CONFLICT DO UPDATE with `transcript = orphans.transcript || EXCLUDED.transcript`,
  // and Postgres serializes concurrent INSERTs on the (venue_id,
  // session_id) unique index so each append observes the previous
  // one. tour_transcript_orphans has UNIQUE INDEX on (venue_id,
  // session_id) per migration 122 (uq_tour_transcript_orphans_venue_session).
  const { data: orphanRow, error: orphanErr } = await supabase.rpc('upsert_orphan_transcript', {
    p_venue_id: venueId,
    p_session_id: sessionId,
    p_audio_provider: audioProvider,
    p_text: aggregateText,
    p_segments_count_delta: segments.length,
    p_last_segment_at: nowIso,
  })

  if (orphanErr || !orphanRow) {
    console.error(
      '[audio-capture/orchestrator] upsert_orphan_transcript failed:',
      orphanErr?.message ?? 'no row returned',
    )
    return { matchedTourId: null, orphanId: null, session: 'orphan', segmentsWritten: 0 }
  }

  // RPC returns either a uuid scalar or a single-row TABLE. Normalise.
  const orphanId =
    typeof orphanRow === 'string'
      ? orphanRow
      : Array.isArray(orphanRow)
        ? ((orphanRow[0] as { id?: string })?.id ?? null)
        : ((orphanRow as { id?: string })?.id ?? null)

  if (!orphanId) {
    return { matchedTourId: null, orphanId: null, session: 'orphan', segmentsWritten: 0 }
  }
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
