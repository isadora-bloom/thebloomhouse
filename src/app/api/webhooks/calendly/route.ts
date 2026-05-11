import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { recordEngagementEvent } from '@/lib/services/heat-mapping'
import { trackCoordinatorAction } from '@/lib/services/intel/consultant-tracking'
import { createHmac, timingSafeEqual } from 'crypto'
import {
  captureDiscoverySource,
  extractDiscoveryAnswerFromCalendly,
  extractReferrerNameFromCalendly,
} from '@/lib/services/discovery-source/capture'

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

    // Look up the contact by email to find the venue and wedding.
    // Contacts schema (001_shared_tables): id, person_id, type, value,
    // is_primary. There is NO venue_id column on contacts — venue scope
    // comes through the join on people.venue_id. Pre-fix this query
    // used columns that don't exist (contact_type / contact_value /
    // contacts.venue_id) and returned no rows for every Calendly
    // webhook — tour bookings silently failed attribution. (Mig 063
    // flagged the contact_type/contact_value mistake; the fix never
    // landed at the call sites.) Fixed 2026-05-11.
    const { data: contact } = await supabase
      .from('contacts')
      .select(`
        person_id,
        people:person_id (
          id,
          venue_id,
          wedding_id
        )
      `)
      .eq('type', 'email')
      .ilike('value', inviteeEmail)
      .limit(1)
      .single()

    if (!contact) {
      console.log(
        `[webhook/calendly] No matching contact for ${inviteeEmail} — skipping engagement event`
      )
      return NextResponse.json({ received: true })
    }

    const person = contact.people as unknown as {
      id: string
      venue_id: string | null
      wedding_id: string | null
    } | null
    const venueId = person?.venue_id as string | undefined
    const weddingId = person?.wedding_id

    if (!venueId) {
      console.log(
        `[webhook/calendly] Contact ${inviteeEmail} has no linked venue — skipping engagement event`
      )
      return NextResponse.json({ received: true })
    }

    if (!weddingId) {
      console.log(
        `[webhook/calendly] Contact ${inviteeEmail} has no linked wedding — skipping engagement event`
      )
      return NextResponse.json({ received: true })
    }

    // Record the tour_booked engagement event. Direction: inbound —
    // couple booked their own tour through Calendly. Per Playbook
    // INV-13 every engagement_event ships with explicit direction.
    const result = await recordEngagementEvent(venueId, weddingId, 'tour_booked', 'inbound', {
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
        // signal-class-justified: tours are structurally always touchpoint
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
          signal_class: 'touchpoint',
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

    // Wave 15 — discovery-source capture from Calendly Q&A.
    // Calendly's questions_and_answers carries the operator's custom
    // questions; we extract "How did you hear about us?" + map to a
    // canonical source, write to discovery_sources, and fan out an
    // attribution_events row so the answer surfaces in ROI rollups +
    // on the reconstructed identity panel.
    // Idempotent on (venue, person, capture_source, capture_ref) so a
    // retried webhook never double-writes.
    try {
      const discoveryAnswer = extractDiscoveryAnswerFromCalendly(payload)
      if (discoveryAnswer) {
        const referrerName = extractReferrerNameFromCalendly(payload)
        const captureResult = await captureDiscoverySource({
          venueId,
          weddingId,
          personId: person?.id ?? null,
          captureSource: 'calendly',
          questionText: discoveryAnswer.questionText,
          answerText: discoveryAnswer.answerText,
          captureRef: (payload.uri as string) ?? null,
          referrerName,
          supabase,
        })
        console.log(
          `[webhook/calendly] Discovery source captured: ` +
            `"${discoveryAnswer.answerText}" → ${captureResult.canonical} ` +
            `(rule=${captureResult.ruleMatched}, inserted=${captureResult.inserted})`,
        )
      }
    } catch (discoveryErr) {
      console.error('[webhook/calendly] Discovery-source capture failed:', discoveryErr)
    }

    // Wave 4 Phase 2 — signal-driven identity reconstruction enqueue.
    // A new Calendly booking is fresh signal (the inviteeName +
    // scheduled_event time + Calendly URI all feed the next
    // reconstruction). 24h dedupe lives inside the helper. Fire-and-
    // forget — never fail the webhook response if enqueue fails.
    try {
      const { enqueueIdentityReconstruction } = await import(
        '@/lib/services/identity/enqueue-reconstruction'
      )
      await enqueueIdentityReconstruction({
        weddingId,
        venueId,
        triggerSignal: 'calendar_invite',
      })
    } catch (err) {
      console.warn(
        '[webhook/calendly] identity-reconstruction enqueue failed (non-fatal):',
        err instanceof Error ? err.message : err,
      )
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
