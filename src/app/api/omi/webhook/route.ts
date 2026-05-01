/**
 * /api/omi/webhook?token=<uuid>
 *
 * T2-E Phase 2 (2026-05-01): the route is now a thin shim. Auth +
 * provider selection happens here; segment normalisation is owned by
 * the OMI adapter (src/lib/services/audio-capture/adapters/omi-adapter.ts);
 * persistence + binding (tour vs orphan) is owned by the orchestrator
 * (src/lib/services/audio-capture/orchestrator.ts). Adding a new
 * provider — iPhone upload, Otter, AssemblyAI, Deepgram — = drop a
 * new adapter in adapters/ and add a route that delegates to the
 * orchestrator.
 *
 * Auth model: per-venue token, not session auth. OMI posts from the
 * wearable (or the OMI backend on its behalf) without any user
 * session. The token in the query string is the only thing tying a
 * segment to a venue.
 *
 * Cost-ceiling gate: extractTourTranscript fires Sonnet (tier-1) per
 * tour. Paused venues skip per Playbook 21.4.3. Coordinator manual
 * regenerate (POST /api/agent/tour-transcript-extract) is NOT gated
 * — that's a coordinator request, not autonomous fire.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { extractTourTranscript } from '@/lib/services/tour-transcript-extract'
import { omiAdapter } from '@/lib/services/audio-capture/adapters/omi-adapter'
import { persistAudioSegments } from '@/lib/services/audio-capture/orchestrator'

interface ExtractionTriggerInput {
  venueId: string
  tourId: string
  outcome: string | null
  scheduledAt: string | null
  transcript: string
}

function maybeFireExtraction(input: ExtractionTriggerInput): void {
  const { venueId, tourId, outcome, scheduledAt, transcript } = input
  if (!tourId || !transcript) return

  const outcomeComplete = outcome === 'completed' || outcome === 'booked'
  const scheduledMs = scheduledAt ? new Date(scheduledAt).getTime() : NaN
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  const pastEnough = Number.isFinite(scheduledMs) && scheduledMs < oneHourAgo
  const longEnough = transcript.length > 500

  if (!outcomeComplete && !(pastEnough && longEnough)) return

  void (async () => {
    const { isAutonomousPaused } = await import('@/lib/services/cost-ceiling')
    if (await isAutonomousPaused(venueId)) {
      console.log(`[api/omi/webhook] auto-extract skipped — venue ${venueId} is paused`)
      return
    }
    try {
      await extractTourTranscript(tourId)
    } catch (err) {
      console.error('[api/omi/webhook] auto-extract failed:', err)
    }
  })()
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

    const rawPayload = await request.json().catch(() => null)
    if (!rawPayload) {
      return NextResponse.json({ error: 'bad_payload' }, { status: 400 })
    }

    // Adapter parses → normalised segments. Orchestrator persists.
    const sessionId = omiAdapter.extractSessionId(rawPayload)
    if (!sessionId) {
      return NextResponse.json({ error: 'bad_payload' }, { status: 400 })
    }
    const segments = omiAdapter.parseSegments(rawPayload)
    if (segments.length === 0) {
      // Empty ping (no text yet) is still a legit OMI event; ack it
      // without writing. Prevents empty transcript appends.
      return NextResponse.json({ session: 'empty', received: true })
    }

    const result = await persistAudioSegments({
      supabase: service,
      venueId,
      sessionId,
      audioProvider: omiAdapter.providerKey,
      segments,
      autoMatchEnabled,
      matchWindowHours: windowHours,
    })

    if (result.matchedTourId) {
      // Re-read the bound tour to fire extraction with current state.
      const { data: tour } = await service
        .from('tours')
        .select('outcome, scheduled_at, transcript')
        .eq('id', result.matchedTourId)
        .maybeSingle()
      maybeFireExtraction({
        venueId,
        tourId: result.matchedTourId,
        outcome: (tour?.outcome as string | null) ?? null,
        scheduledAt: (tour?.scheduled_at as string | null) ?? null,
        transcript: typeof tour?.transcript === 'string' ? tour.transcript : '',
      })
      return NextResponse.json({
        matched_tour_id: result.matchedTourId,
        session: result.session,
        segments_written: result.segmentsWritten,
      })
    }
    if (result.orphanId) {
      return NextResponse.json({
        orphan_id: result.orphanId,
        session: result.session,
        segments_written: result.segmentsWritten,
      })
    }
    return NextResponse.json({ session: result.session })
  } catch (err) {
    console.error('[api/omi/webhook] unexpected error:', err)
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
