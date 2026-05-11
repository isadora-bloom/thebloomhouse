/**
 * /api/webhooks/zoom  — Wave 29 (multi-channel inbox: Zoom ingestion)
 *
 * Two event types handled:
 *   1. `endpoint.url_validation` — Zoom's CRC challenge on app save.
 *      We respond with the HMAC-SHA256 of the plainToken using the
 *      Secret Token configured in the Zoom app.
 *   2. `meeting.ended` — coordinator's tour or call concluded. We log
 *      the event but don't write an interaction yet (transcript arrives
 *      separately).
 *   3. `recording.transcript_completed` — the meaty event. We download
 *      the VTT transcript via the embedded `download_token`, clean it
 *      to plaintext, look up which venue owns the host_email, resolve
 *      the couple via tours scheduled inside the meeting window, and
 *      write an interaction with type='meeting', surface='voice_capture'.
 *
 * Env-var guard: ZOOM_WEBHOOK_SECRET is required (signature verification).
 * Without it we 503 with `{ error: 'zoom_not_configured' }`. The
 * download_token in the payload makes the per-recording fetch work
 * without ZOOM_OAUTH_TOKEN; the OAuth token is only needed for replay
 * + manual reprocessing.
 *
 * Idempotency: zoom_webhook_log has UNIQUE(meeting_uuid, event_type).
 * A retried delivery returns 200 with no duplicate side-effects.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'crypto'
import { createServiceClient } from '@/lib/supabase/service'
import {
  verifyZoomSignature,
  buildZoomValidationResponse,
} from '@/lib/services/zoom/signature'
import { fetchAndCleanZoomTranscript } from '@/lib/services/zoom/fetch-transcript'
import { enqueueIdentityReconstruction } from '@/lib/services/identity/enqueue-reconstruction'

function jsonError(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status })
}

interface ZoomMeetingObject {
  uuid?: string
  id?: number | string
  topic?: string
  host_email?: string
  start_time?: string
  duration?: number
  recording_files?: Array<{
    file_type?: string
    download_url?: string
    file_extension?: string
    recording_type?: string
    play_url?: string
  }>
}

interface ZoomEventPayload {
  event: string
  payload: {
    plainToken?: string
    account_id?: string
    object?: ZoomMeetingObject
    download_token?: string
  }
}

/** Find a transcript-shaped recording_file URL in the payload. */
function findTranscriptUrl(obj: ZoomMeetingObject | undefined): string | null {
  const files = obj?.recording_files ?? []
  for (const f of files) {
    const t = (f.file_type || '').toUpperCase()
    const ext = (f.file_extension || '').toUpperCase()
    if (t === 'TRANSCRIPT' || ext === 'VTT') return f.download_url ?? null
  }
  return null
}

/** Locate the venue that registered this host_email for Zoom. */
async function locateVenueByHostEmail(
  supabase: ReturnType<typeof createServiceClient>,
  hostEmail: string,
): Promise<string | null> {
  if (!hostEmail) return null
  const normalised = hostEmail.toLowerCase().trim()
  const { data, error } = await supabase
    .from('multi_channel_inbox_settings')
    .select('venue_id, zoom_account_emails')
    .eq('zoom_enabled', true)
    .contains('zoom_account_emails', [normalised])
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error('[webhook/zoom] venue lookup failed:', error.message)
    return null
  }
  return (data?.venue_id as string | undefined) ?? null
}

/**
 * Find the tour (and through it the wedding) the host was meeting with.
 *
 * Heuristic: look for a tour in the same venue with `scheduled_at`
 * within +/- 2 hours of the meeting start time AND tour_type in the
 * "virtual" set (zoom / video / virtual). Falls back to widest window
 * if no tour_type filter matches.
 *
 * Returns { weddingId, personId } when a single match emerges; nulls
 * when ambiguous (multiple tours in window — coordinator review path).
 */
async function locateCoupleForMeeting(
  supabase: ReturnType<typeof createServiceClient>,
  venueId: string,
  startTime: string | null,
): Promise<{ weddingId: string | null; personId: string | null }> {
  if (!startTime) return { weddingId: null, personId: null }
  const startMs = Date.parse(startTime)
  if (!Number.isFinite(startMs)) return { weddingId: null, personId: null }
  const lo = new Date(startMs - 2 * 60 * 60 * 1000).toISOString()
  const hi = new Date(startMs + 2 * 60 * 60 * 1000).toISOString()

  const { data, error } = await supabase
    .from('tours')
    .select('id, wedding_id, tour_type, scheduled_at')
    .eq('venue_id', venueId)
    .gte('scheduled_at', lo)
    .lte('scheduled_at', hi)
    .limit(10)
  if (error || !data || data.length === 0) {
    return { weddingId: null, personId: null }
  }
  // Prefer virtual tour types first.
  const virtualMatches = data.filter((t) => {
    const tt = ((t.tour_type as string | null) ?? '').toLowerCase()
    return tt.includes('virtual') || tt.includes('zoom') || tt.includes('video')
  })
  const candidates = virtualMatches.length > 0 ? virtualMatches : data
  if (candidates.length !== 1) {
    // Ambiguous — coordinator review.
    return { weddingId: null, personId: null }
  }
  const weddingId = (candidates[0].wedding_id as string | null) ?? null
  return { weddingId, personId: null }
}

export async function POST(request: NextRequest) {
  const secret = process.env.ZOOM_WEBHOOK_SECRET
  if (!secret) {
    return jsonError('zoom_not_configured', 503)
  }

  const correlationId = randomUUID()
  const rawBody = await request.text()

  // ---- Signature verification ----
  const sigHeader = request.headers.get('x-zm-signature')
  const tsHeader = request.headers.get('x-zm-request-timestamp')
  const sigOk = verifyZoomSignature({
    rawBody,
    timestampHeader: tsHeader,
    signatureHeader: sigHeader,
    secret,
  })
  if (!sigOk) {
    console.warn('[webhook/zoom] signature verification failed', {
      correlationId,
      hasSig: Boolean(sigHeader),
      hasTs: Boolean(tsHeader),
    })
    return jsonError('invalid_signature', 401)
  }

  let event: ZoomEventPayload
  try {
    event = JSON.parse(rawBody) as ZoomEventPayload
  } catch {
    return jsonError('bad_payload', 400)
  }

  // ---- CRC: endpoint.url_validation handshake ----
  if (event.event === 'endpoint.url_validation' && event.payload?.plainToken) {
    const resp = buildZoomValidationResponse(event.payload.plainToken, secret)
    return NextResponse.json(resp)
  }

  const eventType = event.event
  const obj = event.payload?.object
  const meetingUuid = obj?.uuid ?? null

  if (!meetingUuid || !eventType) {
    return NextResponse.json({ received: true })
  }

  const supabase = createServiceClient()

  // ---- Idempotency check ----
  const { data: existing } = await supabase
    .from('zoom_webhook_log')
    .select('id, interaction_id')
    .eq('meeting_uuid', meetingUuid)
    .eq('event_type', eventType)
    .maybeSingle()
  if (existing) {
    console.log('[webhook/zoom] duplicate event, idempotent ack', {
      meetingUuid,
      eventType,
    })
    return NextResponse.json({ received: true, idempotent: true })
  }

  // ---- Locate venue ----
  const hostEmail = obj?.host_email ?? ''
  const venueId = await locateVenueByHostEmail(supabase, hostEmail)
  if (!venueId) {
    // Log without venue so a misconfigured host_email is auditable.
    await supabase.from('zoom_webhook_log').insert({
      venue_id: null,
      meeting_uuid: meetingUuid,
      event_type: eventType,
      topic: obj?.topic ?? null,
      host_email: hostEmail || null,
      start_time: obj?.start_time ?? null,
      duration_minutes:
        typeof obj?.duration === 'number' ? Math.round(obj.duration) : null,
      raw_payload: event,
      interaction_id: null,
    })
    console.warn('[webhook/zoom] no venue claims host_email; logged without interaction', {
      hostEmail,
      eventType,
    })
    return NextResponse.json({ received: true })
  }

  // ---- meeting.ended: log only, no interaction ----
  if (eventType === 'meeting.ended') {
    await supabase.from('zoom_webhook_log').insert({
      venue_id: venueId,
      meeting_uuid: meetingUuid,
      event_type: eventType,
      topic: obj?.topic ?? null,
      host_email: hostEmail || null,
      start_time: obj?.start_time ?? null,
      duration_minutes:
        typeof obj?.duration === 'number' ? Math.round(obj.duration) : null,
      raw_payload: event,
      interaction_id: null,
    })
    console.log('[webhook/zoom] meeting.ended logged', { meetingUuid, venueId })
    return NextResponse.json({ received: true })
  }

  // ---- recording.transcript_completed: download + write interaction ----
  if (eventType !== 'recording.transcript_completed') {
    // Unknown event — log and ack so Zoom doesn't retry.
    await supabase.from('zoom_webhook_log').insert({
      venue_id: venueId,
      meeting_uuid: meetingUuid,
      event_type: eventType,
      topic: obj?.topic ?? null,
      host_email: hostEmail || null,
      start_time: obj?.start_time ?? null,
      duration_minutes:
        typeof obj?.duration === 'number' ? Math.round(obj.duration) : null,
      raw_payload: event,
      interaction_id: null,
    })
    return NextResponse.json({ received: true, ignored: true })
  }

  const transcriptUrl = findTranscriptUrl(obj)
  if (!transcriptUrl) {
    await supabase.from('zoom_webhook_log').insert({
      venue_id: venueId,
      meeting_uuid: meetingUuid,
      event_type: eventType,
      topic: obj?.topic ?? null,
      host_email: hostEmail || null,
      start_time: obj?.start_time ?? null,
      duration_minutes:
        typeof obj?.duration === 'number' ? Math.round(obj.duration) : null,
      transcript_url: null,
      raw_payload: event,
      interaction_id: null,
    })
    console.warn('[webhook/zoom] transcript event without transcript_url', { meetingUuid })
    return NextResponse.json({ received: true, reason: 'no_transcript_file' })
  }

  // Fetch + clean transcript. Best-effort: if fetch fails we still log
  // the event so manual reprocess can pick it up later.
  const fetched = await fetchAndCleanZoomTranscript({
    transcriptUrl,
    downloadToken: event.payload?.download_token ?? null,
  })

  // ---- Locate couple by tour-time match ----
  const couple = await locateCoupleForMeeting(
    supabase,
    venueId,
    obj?.start_time ?? null,
  )

  let interactionId: string | null = null
  if (fetched.ok && fetched.text) {
    const body = fetched.text
    const timestampIso = obj?.start_time ?? new Date().toISOString()
    const { data: interaction, error: interactionErr } = await supabase
      .from('interactions')
      .insert({
        venue_id: venueId,
        wedding_id: couple.weddingId,
        person_id: couple.personId,
        type: 'meeting',
        direction: 'inbound',
        subject: obj?.topic ?? 'Zoom meeting',
        body_preview: body.slice(0, 300),
        full_body: body,
        from_email: null,
        from_name: hostEmail || null,
        timestamp: timestampIso,
        correlation_id: correlationId,
        author_class: 'couple',
        surface: 'voice_capture',
        signal_class: 'touchpoint',
      })
      .select('id')
      .single()
    if (interactionErr) {
      console.error('[webhook/zoom] interaction insert failed:', interactionErr.message)
    } else if (interaction) {
      interactionId = interaction.id as string
    }
  } else {
    console.warn('[webhook/zoom] transcript fetch failed', {
      meetingUuid,
      reason: fetched.reason,
    })
  }

  // ---- Log webhook ----
  const { error: logErr } = await supabase.from('zoom_webhook_log').insert({
    venue_id: venueId,
    meeting_uuid: meetingUuid,
    event_type: eventType,
    topic: obj?.topic ?? null,
    host_email: hostEmail || null,
    start_time: obj?.start_time ?? null,
    duration_minutes:
      typeof obj?.duration === 'number' ? Math.round(obj.duration) : null,
    transcript_url: transcriptUrl,
    raw_payload: event,
    interaction_id: interactionId,
  })
  if (logErr) {
    console.warn('[webhook/zoom] webhook_log insert failed:', logErr.message)
  }

  // ---- Lifecycle + reconstruction ----
  if (couple.weddingId && interactionId) {
    void (async () => {
      try {
        const { recordZoomLifecycleSignal } = await import(
          '@/lib/services/lifecycle/state-machine'
        )
        await recordZoomLifecycleSignal({
          supabase,
          venueId,
          weddingId: couple.weddingId!,
          meetingStartTime: obj?.start_time ?? null,
        })
      } catch (err) {
        console.warn('[webhook/zoom] lifecycle signal hook failed (non-fatal):', err)
      }
    })()
    void enqueueIdentityReconstruction({
      weddingId: couple.weddingId,
      venueId,
      triggerSignal: 'zoom_transcript_received',
    }).catch((err) =>
      console.warn('[webhook/zoom] reconstruction enqueue failed (non-fatal):', err),
    )
  }

  console.log('[webhook/zoom] processed', {
    correlationId,
    venueId,
    meetingUuid,
    eventType,
    interactionId,
    weddingId: couple.weddingId,
  })

  return NextResponse.json({ received: true, interaction_id: interactionId })
}

/**
 * GET returns 405 so a misconfigured Zoom dashboard surfaces clearly.
 */
export async function GET() {
  return jsonError('method_not_allowed', 405)
}
