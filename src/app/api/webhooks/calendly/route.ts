import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { recordEngagementEvent } from '@/lib/services/heat-mapping'

// ---------------------------------------------------------------------------
// Calendly webhook handler
//
// Creates a tour_booked engagement event when a Calendly invitee is created
// (i.e., someone books a tour through Calendly).
//
// TODO: In production, validate the webhook signature using Calendly's
// webhook signing key. See: https://developer.calendly.com/api-docs/
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// POST — Handle Calendly webhook events
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // TODO: Validate webhook signature in production
    // const signature = request.headers.get('calendly-webhook-signature')
    // if (!signature || !verifyCalendlySignature(rawBody, signature)) {
    //   return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
    // }

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

    return NextResponse.json({ received: true, engagementRecorded: true })
  } catch (err) {
    console.error('[webhook/calendly] Error processing webhook:', err)
    return NextResponse.json(
      { error: 'Webhook processing failed' },
      { status: 500 }
    )
  }
}
