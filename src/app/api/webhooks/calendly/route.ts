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
    // Calendly puts the booking-creation timestamp on the invitee object
    // (payload). When present this is the "when the couple actually
    // booked" moment — what the resolver needs for inquiry_date pinning.
    // Fall back to NOW() inside mintWedding when missing.
    const inviteeCreatedAt = (payload.created_at as string | undefined) ?? null

    if (!inviteeEmail) {
      console.warn('[webhook/calendly] No email in invitee payload')
      return NextResponse.json({ received: true })
    }

    // ---- Venue resolution ----
    // Two paths in priority order, both venue-scoped so cold bookings at
    // venue #N route correctly:
    //
    //   A. Calendly host URI. The webhook payload's
    //      scheduled_event.event_memberships[*].user is the host's
    //      Calendly user URI. Each onboarded venue stores its own URI in
    //      venue_config.calendly_tokens.user. This is the deterministic
    //      multi-venue routing key — every venue's webhook lands at its
    //      own venue_id regardless of whether the invitee email has
    //      been seen before.
    //
    //   B. Contact email lookup. Legacy path. Only resolves for
    //      returning invitees whose person row already carries a venue_id.
    //      First-time invitees miss path B by definition — that's the
    //      G1 gap this fix closes.
    let venueId: string | undefined
    let resolvedPersonId: string | null = null
    let resolvedWeddingId: string | null = null
    let resolutionPath: 'host_uri' | 'contact_email' | 'none' = 'none'

    // Path A — host URI match
    const memberships = (scheduledEvent?.event_memberships as
      | Array<Record<string, unknown>>
      | undefined) ?? []
    const hostUris = memberships
      .map((m) => (m.user as string | undefined) ?? null)
      .filter((u): u is string => typeof u === 'string' && u.length > 0)
    if (hostUris.length > 0) {
      // venue_config.calendly_tokens is jsonb. Use Supabase's
      // `eq('calendly_tokens->>user', uri)` per-URI rather than `.or()`
      // — the latter's filter parser breaks on `://` in URIs. Typical
      // N=1 (one host per invitee event), so the extra round-trips are
      // negligible.
      const matchedVenueIds: string[] = []
      for (const uri of hostUris) {
        const { data: rows, error: venueLookupErr } = await supabase
          .from('venue_config')
          .select('venue_id')
          .eq('calendly_tokens->>user', uri)
          .limit(2)
        if (venueLookupErr) {
          console.warn(
            '[webhook/calendly] venue_config lookup by host URI failed:',
            venueLookupErr.message,
          )
          continue
        }
        for (const r of rows ?? []) {
          const vId = r.venue_id as string | null
          if (vId) matchedVenueIds.push(vId)
        }
      }
      const uniqueVenueIds = Array.from(new Set(matchedVenueIds))
      if (uniqueVenueIds.length > 1) {
        console.warn(
          `[webhook/calendly] Multiple venues share Calendly host URI ` +
            `${hostUris.join(',')} — picking first. Investigate.`,
        )
      }
      if (uniqueVenueIds.length > 0) {
        venueId = uniqueVenueIds[0]
        resolutionPath = 'host_uri'
      }
    }

    // Path B — contact email match (legacy / fallback for returning invitees)
    // Always run this to recover the person + wedding ids even when path
    // A already supplied venueId — the contact may already be attached to
    // a wedding at this venue.
    const { data: contactRows } = await supabase
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
      .limit(5)
    if (contactRows && contactRows.length > 0) {
      // When venueId already resolved via path A, scope contact match to
      // that venue. Otherwise take the first contact's venue (legacy
      // behaviour). The narrow venue-scoped match is what makes this
      // safe for multi-venue: an invitee whose email exists at venue X
      // booking at venue Y won't get incorrectly attached to venue X.
      const candidates = contactRows
        .map((row) => {
          const p = row.people as unknown as {
            id: string
            venue_id: string | null
            wedding_id: string | null
          } | null
          return p
        })
        .filter((p): p is { id: string; venue_id: string | null; wedding_id: string | null } => !!p)
      const match =
        (venueId
          ? candidates.find((p) => p.venue_id === venueId)
          : candidates[0]) ?? null
      if (match) {
        if (!venueId && match.venue_id) {
          venueId = match.venue_id
          resolutionPath = 'contact_email'
        }
        resolvedPersonId = match.id
        resolvedWeddingId = match.wedding_id
      }
    }

    if (!venueId) {
      console.log(
        `[webhook/calendly] No venue resolution for ${inviteeEmail} ` +
          `(host URIs: ${hostUris.join(',') || 'none'}) — dropping. ` +
          `If this venue has Calendly configured, ensure ` +
          `venue_config.calendly_tokens.user matches the Calendly user URI.`,
      )
      return NextResponse.json({ received: true })
    }

    // ---- Wedding resolution (mint on cold booking) ----
    // If the contact lookup found a wedding_id, use it. Otherwise call
    // mintWedding — this is the G1 fix: every cold Calendly booking gets
    // a wedding minted rather than silently dropped. mintWedding wraps
    // resolveIdentity which is venue-scoped, so the same invitee email
    // booking at a different venue won't cross-contaminate.
    let weddingId: string
    if (resolvedWeddingId) {
      weddingId = resolvedWeddingId
    } else {
      try {
        const { mintWedding } = await import('@/lib/services/identity/mint-wedding')
        const minted = await mintWedding({
          venueId,
          source: 'calendly_webhook' as const,
          signals: {
            email: inviteeEmail,
            fullName: inviteeName ?? null,
            // No phone in standard Calendly invitee payload — would be in
            // Q&A if the venue asks for it. We could mine Q&A here, but
            // mintWedding accepts null phone and the resolver's later
            // Wave-4 reconstruction can pull phone from Q&A on subsequent
            // signals.
            phone: null,
            inquiryDate: inviteeCreatedAt ?? undefined,
          },
          reason: resolutionPath === 'host_uri' ? 'cold_booking' : 'contact_no_wedding',
          supabase,
        })
        weddingId = minted.weddingId
        resolvedPersonId = minted.personId
        console.log(
          `[webhook/calendly] Minted wedding ${weddingId} for ${inviteeEmail} ` +
            `at venue ${venueId} (resolution=${resolutionPath}, ` +
            `resolved_via=${minted.resolvedVia})`,
        )
      } catch (mintErr) {
        console.error(
          '[webhook/calendly] mintWedding failed for cold booking:',
          mintErr instanceof Error ? mintErr.message : mintErr,
        )
        // 200 anyway — Calendly retries on non-2xx and we don't want a
        // mint failure to cause retry-storms.
        return NextResponse.json({ received: true, mintFailed: true })
      }
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
          personId: resolvedPersonId,
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
