/**
 * /api/omi/webhook?token=<uuid>
 *
 * Phase 7 Task 61. Receives Omi real-time transcript segments.
 *
 * Auth model: per-venue token, not session auth. Omi posts from the wearable
 * (or the Omi backend on its behalf) without any user session. The token in
 * the query string is the only thing tying a segment to a venue, so we look
 * it up against venue_config.omi_webhook_token.
 *
 * Payload shape (per Omi developer docs, same shape used in the Ground app):
 *   {
 *     session_id: string,
 *     segments: [
 *       { text: string, is_user?: boolean, speaker?: string, start?: number, end?: number }
 *     ]
 *   }
 *
 * Matching flow:
 *   1. Already-bound session  → append to that tour's transcript.
 *   2. Unbound + auto-match   → find nearest pending/completed tour within
 *                               venue_config.omi_match_window_hours of now();
 *                               bind session + append transcript.
 *   3. Otherwise              → upsert into tour_transcript_orphans for the
 *                               coordinator to triage at /agent/omi-inbox.
 *
 * White-label: the response body never names a venue. Every DB write is
 * service-role so RLS can't surprise us, but all queries are explicitly
 * scoped to the venue_id resolved from the token.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { extractTourTranscript } from '@/lib/services/tour-transcript-extract'

// ---------------------------------------------------------------------------
// Task 62 auto-trigger: once enough transcript has accrued AND the tour
// looks "complete" (outcome in completed/booked OR scheduled_at > 1h ago),
// kick off the AI extraction fire-and-forget so the webhook response stays
// snappy. The extraction service is idempotent on its own failures.
// ---------------------------------------------------------------------------
interface ExtractionTriggerInput {
  tourId: string
  outcome: string | null
  scheduledAt: string | null
  transcript: string
}

function maybeFireExtraction(input: ExtractionTriggerInput): void {
  const { tourId, outcome, scheduledAt, transcript } = input
  if (!tourId || !transcript) return

  const outcomeComplete = outcome === 'completed' || outcome === 'booked'
  const scheduledMs = scheduledAt ? new Date(scheduledAt).getTime() : NaN
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  const pastEnough = Number.isFinite(scheduledMs) && scheduledMs < oneHourAgo
  const longEnough = transcript.length > 500

  if (!outcomeComplete && !(pastEnough && longEnough)) return

  // Fire-and-forget. Never block the webhook response on the extractor.
  extractTourTranscript(tourId).catch((err) => {
    console.error('[api/omi/webhook] auto-extract failed:', err)
  })
}

interface OmiSegment {
  text?: unknown
  is_user?: unknown
  speaker?: unknown
  speaker_id?: unknown
  start?: unknown
  end?: unknown
}

interface OmiPayload {
  session_id?: unknown
  segments?: unknown
}

export async function POST(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get('token')
    if (!token) {
      return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
    }

    const service = createServiceClient()

    const { data: cfg, error: cfgErr } = await service
      .from('venue_config')
      .select('venue_id, omi_auto_match_enabled, omi_match_window_hours')
      .eq('omi_webhook_token', token)
      .maybeSingle()

    if (cfgErr) {
      console.error('[api/omi/webhook] venue_config lookup error:', cfgErr.message)
      return NextResponse.json({ error: 'internal' }, { status: 500 })
    }
    if (!cfg?.venue_id) {
      return NextResponse.json({ error: 'invalid_token' }, { status: 401 })
    }

    const venueId = cfg.venue_id as string
    const autoMatchEnabled = cfg.omi_auto_match_enabled !== false
    const windowHours = typeof cfg.omi_match_window_hours === 'number'
      ? cfg.omi_match_window_hours
      : 6

    const body = (await request.json().catch(() => null)) as OmiPayload | null
    if (!body || typeof body.session_id !== 'string' || !Array.isArray(body.segments)) {
      return NextResponse.json({ error: 'bad_payload' }, { status: 400 })
    }

    const sessionId = body.session_id
    const segments = body.segments as OmiSegment[]
    const segmentText = segments
      .map((s) => (typeof s.text === 'string' ? s.text : ''))
      .filter((t) => t.length > 0)
      .join(' ')
      .trim()

    // An empty ping (no text yet) is still a legit Omi event; just ack it
    // without writing anything. Prevents empty transcript appends that
    // would show up as stray spaces.
    if (!segmentText) {
      return NextResponse.json({ session: 'empty', received: true })
    }

    const nowIso = new Date().toISOString()

    // ---------- 1. Already-bound session? ------------------------------------
    const { data: boundTour, error: boundErr } = await service
      .from('tours')
      .select('id, transcript, outcome, scheduled_at')
      .eq('venue_id', venueId)
      .eq('omi_session_id', sessionId)
      .maybeSingle()

    if (boundErr) {
      console.error('[api/omi/webhook] bound tour lookup error:', boundErr.message)
      return NextResponse.json({ error: 'internal' }, { status: 500 })
    }

    if (boundTour?.id) {
      const current = typeof boundTour.transcript === 'string' ? boundTour.transcript : ''
      const nextTranscript = current ? `${current} ${segmentText}` : segmentText
      const { error: updErr } = await service
        .from('tours')
        .update({
          transcript: nextTranscript,
          transcript_received_at: nowIso,
        })
        .eq('id', boundTour.id)
        .eq('venue_id', venueId)
      if (updErr) {
        console.error('[api/omi/webhook] tour append error:', updErr.message)
        return NextResponse.json({ error: 'internal' }, { status: 500 })
      }
      maybeFireExtraction({
        tourId: boundTour.id as string,
        outcome: (boundTour.outcome as string | null) ?? null,
        scheduledAt: (boundTour.scheduled_at as string | null) ?? null,
        transcript: nextTranscript,
      })
      return NextResponse.json({ matched_tour_id: boundTour.id, session: 'existing' })
    }

    // ---------- 2. Auto-match to nearest pending/completed tour --------------
    if (autoMatchEnabled) {
      const nowMs = Date.now()
      const windowMs = windowHours * 60 * 60 * 1000
      const lowerIso = new Date(nowMs - windowMs).toISOString()
      const upperIso = new Date(nowMs + windowMs).toISOString()

      const { data: candidates, error: candErr } = await service
        .from('tours')
        .select('id, scheduled_at, transcript, omi_session_id, outcome')
        .eq('venue_id', venueId)
        .in('outcome', ['pending', 'completed'])
        .is('omi_session_id', null)
        .gte('scheduled_at', lowerIso)
        .lte('scheduled_at', upperIso)

      if (candErr) {
        console.error('[api/omi/webhook] candidate lookup error:', candErr.message)
        return NextResponse.json({ error: 'internal' }, { status: 500 })
      }

      const nearest = (candidates ?? [])
        .map((t) => ({
          id: t.id as string,
          transcript: (typeof t.transcript === 'string' ? t.transcript : '') as string,
          outcome: (t.outcome as string | null) ?? null,
          scheduledAt: (t.scheduled_at as string | null) ?? null,
          delta: Math.abs(
            new Date((t.scheduled_at as string) || nowIso).getTime() - nowMs
          ),
        }))
        .sort((a, b) => a.delta - b.delta)[0]

      if (nearest) {
        const current = nearest.transcript
        const nextTranscript = current ? `${current} ${segmentText}` : segmentText
        const { error: bindErr } = await service
          .from('tours')
          .update({
            omi_session_id: sessionId,
            transcript: nextTranscript,
            transcript_received_at: nowIso,
          })
          .eq('id', nearest.id)
          .eq('venue_id', venueId)
        if (bindErr) {
          console.error('[api/omi/webhook] tour bind error:', bindErr.message)
          return NextResponse.json({ error: 'internal' }, { status: 500 })
        }
        maybeFireExtraction({
          tourId: nearest.id,
          outcome: nearest.outcome,
          scheduledAt: nearest.scheduledAt,
          transcript: nextTranscript,
        })
        return NextResponse.json({ matched_tour_id: nearest.id, session: 'new_match' })
      }
    }

    // ---------- 3. Orphan it ------------------------------------------------
    // Read existing orphan (if any) so we can append rather than overwrite.
    const { data: existingOrphan } = await service
      .from('tour_transcript_orphans')
      .select('id, transcript, segments_count')
      .eq('venue_id', venueId)
      .eq('omi_session_id', sessionId)
      .maybeSingle()

    const currentOrphanText = typeof existingOrphan?.transcript === 'string'
      ? existingOrphan.transcript
      : ''
    const currentCount = typeof existingOrphan?.segments_count === 'number'
      ? existingOrphan.segments_count
      : 0
    const nextOrphanText = currentOrphanText
      ? `${currentOrphanText} ${segmentText}`
      : segmentText

    const { data: orphan, error: orphanErr } = await service
      .from('tour_transcript_orphans')
      .upsert(
        {
          venue_id: venueId,
          omi_session_id: sessionId,
          transcript: nextOrphanText,
          segments_count: currentCount + segments.length,
          last_segment_at: nowIso,
          status: 'pending',
        },
        { onConflict: 'venue_id,omi_session_id' }
      )
      .select('id')
      .single()

    if (orphanErr || !orphan) {
      console.error('[api/omi/webhook] orphan upsert error:', orphanErr?.message)
      return NextResponse.json({ error: 'internal' }, { status: 500 })
    }

    return NextResponse.json({ orphan_id: orphan.id, session: 'orphan' })
  } catch (err) {
    console.error('[api/omi/webhook] unexpected error:', err)
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
