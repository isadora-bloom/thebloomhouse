import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { recordEngagementEvent } from '@/lib/services/heat-mapping'
import { trackCoordinatorAction } from '@/lib/services/consultant-tracking'
import { createHmac, timingSafeEqual } from 'crypto'

// ---------------------------------------------------------------------------
// Calendly webhook handler
//
// Creates a tour_booked engagement event when a Calendly invitee is created
// (i.e., someone books a tour through Calendly).
//
// Signature validation: Calendly signs webhooks using HMAC-SHA256.
// The signature header is `Calendly-Webhook-Signature` with format:
//   t=<timestamp>,v1=<signature>
// See: https://developer.calendly.com/api-docs/ZG9jOjM2MzE2MDM4-webhook-signatures
// ---------------------------------------------------------------------------

/**
 * Verify a Calendly webhook signature.
 * Calendly uses the same format as Stripe: t=<timestamp>,v1=<hmac>
 */
function verifyCalendlySignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300
): boolean {
  try {
    const parts = signatureHeader.split(',')
    const tsPart = parts.find((p) => p.startsWith('t='))
    const v1Part = parts.find((p) => p.startsWith('v1='))

    if (!tsPart || !v1Part) return false

    const timestamp = tsPart.replace('t=', '')
    const signature = v1Part.replace('v1=', '')

    // Reject stale events
    const tsNum = parseInt(timestamp, 10)
    if (isNaN(tsNum)) return false
    const now = Math.floor(Date.now() / 1000)
    if (Math.abs(now - tsNum) > toleranceSeconds) return false

    // Compute expected signature: HMAC-SHA256(secret, "timestamp.body")
    const signedPayload = `${timestamp}.${rawBody}`
    const expected = createHmac('sha256', secret)
      .update(signedPayload, 'utf8')
      .digest('hex')

    const expectedBuf = Buffer.from(expected, 'hex')
    const actualBuf = Buffer.from(signature, 'hex')

    if (expectedBuf.length !== actualBuf.length) return false
    return timingSafeEqual(expectedBuf, actualBuf)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// POST — Handle Calendly webhook events
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    // Read raw body for signature validation, then parse
    const rawBody = await request.text()

    // ---- Signature validation ----
    const sigHeader = request.headers.get('calendly-webhook-signature')
    const webhookSecret = process.env.CALENDLY_WEBHOOK_SECRET

    if (webhookSecret) {
      if (!sigHeader) {
        console.warn('[webhook/calendly] Missing Calendly-Webhook-Signature header')
        return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
      }

      if (!verifyCalendlySignature(rawBody, sigHeader, webhookSecret)) {
        console.warn('[webhook/calendly] Invalid webhook signature')
        return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
      }
    } else {
      console.warn(
        '[webhook/calendly] CALENDLY_WEBHOOK_SECRET not set — skipping signature validation. ' +
        'Set this env var in production.'
      )
    }

    const body = JSON.parse(rawBody)

    const eventType = body.event as string | undefined
    const payload = body.payload as Record<string, unknown> | undefined

    console.log(`[webhook/calendly] Received event: ${eventType}`, {
      event: eventType,
      uri: payload?.uri,
    })

    if (eventType !== 'invitee.created') {
      // Only handle new bookings for now
      console.log(`[webhook/calendly] Ignoring event type: ${eventType}`)
      return NextResponse.json({ received: true })
    }

    if (!payload) {
      console.warn('[webhook/calendly] Missing payload in invitee.created event')
      return NextResponse.json({ received: true })
    }

    const supabase = createServiceClient()

    // Extract invitee info
    const inviteeEmail = (payload.email as string)?.toLowerCase()
    const inviteeName = payload.name as string | undefined
    const scheduledEvent = payload.scheduled_event as Record<string, unknown> | undefined
    const startTime = scheduledEvent?.start_time as string | undefined

    if (!inviteeEmail) {
      console.warn('[webhook/calendly] No email in invitee payload')
      return NextResponse.json({ received: true })
    }

    // Look up the contact by email to find the venue and wedding
    const { data: contact } = await supabase
      .from('contacts')
      .select(`
        venue_id,
        person_id,
        people:person_id (
          id,
          wedding_id
        )
      `)
      .eq('contact_type', 'email')
      .ilike('contact_value', inviteeEmail)
      .limit(1)
      .single()

    if (!contact) {
      console.log(
        `[webhook/calendly] No matching contact for ${inviteeEmail} — skipping engagement event`
      )
      return NextResponse.json({ received: true })
    }

    const venueId = contact.venue_id as string
    const person = contact.people as unknown as { id: string; wedding_id: string | null } | null
    const weddingId = person?.wedding_id

    if (!weddingId) {
      console.log(
        `[webhook/calendly] Contact ${inviteeEmail} has no linked wedding — skipping engagement event`
      )
      return NextResponse.json({ received: true })
    }

    // Record the tour_booked engagement event
    const result = await recordEngagementEvent(venueId, weddingId, 'tour_booked', {
      source: 'calendly',
      inviteeEmail,
      inviteeName: inviteeName ?? null,
      scheduledTime: startTime ?? null,
      calendlyEventUri: payload.uri ?? null,
    })

    console.log(
      `[webhook/calendly] Recorded tour_booked for wedding ${weddingId} ` +
        `(score: ${result.previousScore} -> ${result.newScore})`
    )

    // Phase 2 Task 21: pre-populate the tours table so the coordinator
    // sees the booked tour in /intel/tours immediately. Coordinator fills
    // in attendees + outcome after the tour itself. Idempotent: skip the
    // insert when a tour row already exists for this Calendly URI or for
    // (wedding, scheduled_at) within the same minute.
    try {
      const scheduledAt = startTime || new Date().toISOString()
      const calendlyUri = (payload.uri as string) ?? null

      const { data: existing } = await supabase
        .from('tours')
        .select('id')
        .eq('venue_id', venueId)
        .eq('wedding_id', weddingId)
        .gte('scheduled_at', new Date(new Date(scheduledAt).getTime() - 60_000).toISOString())
        .lte('scheduled_at', new Date(new Date(scheduledAt).getTime() + 60_000).toISOString())
        .limit(1)
        .maybeSingle()

      if (!existing) {
        await supabase.from('tours').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          scheduled_at: scheduledAt,
          tour_type: 'in_person',
          couple_name: inviteeName ?? null,
          source: 'calendly',
          outcome: 'pending',
          notes: calendlyUri ? `Booked via Calendly: ${calendlyUri}` : 'Booked via Calendly',
          attendees: [],
        })
        console.log(`[webhook/calendly] Created pending tour row for wedding ${weddingId}`)
      } else {
        console.log(`[webhook/calendly] Tour row already exists — skipping insert`)
      }
    } catch (tourInsertErr) {
      // Non-fatal — the engagement event is the load-bearing write.
      console.error('[webhook/calendly] Tour pre-populate failed:', tourInsertErr)
    }

    // Track tour_booked in consultant_metrics
    // Try to find the coordinator who owns this wedding
    const { data: weddingRow } = await supabase
      .from('weddings')
      .select('assigned_to')
      .eq('id', weddingId)
      .single()

    if (weddingRow?.assigned_to) {
      await trackCoordinatorAction(venueId, weddingRow.assigned_to as string, 'tour_booked')
      console.log(`[webhook/calendly] Tracked tour_booked for consultant ${weddingRow.assigned_to}`)
    }

    return NextResponse.json({ received: true, engagementRecorded: true })
  } catch (err) {
    console.error('[webhook/calendly] Error processing webhook:', err)
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    )
  }
}
