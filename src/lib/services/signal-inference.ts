/**
 * Text-based signal inference for wedding engagement.
 *
 * Sits alongside the classifier. The classifier emits structured
 * signals (mentionsTourRequest, commitmentLevel, etc.) but is
 * conservative and misses plainly-worded tour confirmations, contract
 * language, and payment signals — especially when they come through
 * HoneyBook / Dubsado / generic CRM notifications that don't read like
 * a natural couple email.
 *
 * This module runs deterministic regex patterns over the full thread
 * on every inbound email. It fires the matching heat events + advances
 * wedding status when appropriate. Events are idempotent via the
 * metadata.source marker, so re-running is safe.
 *
 * Used by:
 *   - email-pipeline.ts processIncomingEmail (every inbound)
 *   - scripts/rixey-scoring-rescue.ts (one-shot historical backfill)
 *
 * Status progression ladder:
 *   inquiry → tour_scheduled → proposal_sent → booked
 */

import { createServiceClient } from '@/lib/supabase/service'
import { recordEngagementEventsBatch } from '@/lib/services/heat-mapping'

// ---------------------------------------------------------------------------
// Pattern sets (source of truth)
// ---------------------------------------------------------------------------

export const TOUR_CONFIRMATION_PATTERNS: RegExp[] = [
  /your tour is confirmed/i,
  /tour is (booked|confirmed|scheduled)/i,
  /confirmed for (a |the )?tour/i,
  /tour confirmation/i,
  /(looking forward to|excited to) (meeting you|your tour|showing you around|seeing you)/i,
  /see you (on|at) (monday|tuesday|wednesday|thursday|friday|saturday|sunday|\w+ \d|\d+[-/]\d+|the \d+)/i,
  /we'll see you/i,
  /(scheduled|set you up) for (a |your )?tour/i,
  /(booked|reserved) (you |a )?tour/i,
  /tour (set|scheduled) for/i,
  /looking forward to (the|your) (tour|visit)/i,
  /added (you|your tour) to (my|the) calendar/i,
]

export const TOUR_REQUEST_PATTERNS: RegExp[] = [
  /(would |we'd |i'd |love to |want to )?(tour|come (see|visit)|schedule a (tour|visit|viewing))/i,
  /available (to|for a) (tour|visit)/i,
  /can we (come |visit|tour|see)/i,
  /set up a tour/i,
  /book a (tour|visit|viewing)/i,
  /tour (availability|dates|times?)/i,
  /(when|what|times?|days?) (is|are) (the |your )?(tour|visits?) available/i,
  /come and (see|visit|tour)/i,
  /swing by/i,
  /visit the venue/i,
  /check out (your|the) venue/i,
]

export const PROPOSAL_SENT_PATTERNS: RegExp[] = [
  /contract (has been |was |is being )?sent/i,
  /proposal (has been |was )?sent/i,
  /(sent|attached) (the |a |your )?(contract|proposal|agreement)/i,
  /please find (the |your )?(contract|proposal|agreement)/i,
  /invoice (has been |was )?sent/i,
  /here('s| is) (the |your )?(contract|proposal|agreement)/i,
]

// Booking-confirmed patterns. EVERY pattern needs explicit wedding /
// date / contract / venue context — otherwise generic phrases like
// "discount is already locked in" or "looking forward to it" trip the
// rule and a venue's own outbound marketing copy advances couples to
// 'booked' incorrectly. Lesson learned the hard way (Millaka, 2026-04-24).
export const BOOKING_PATTERNS: RegExp[] = [
  /(?:the |your |our )?contract (is |has been )?signed/i,
  /(deposit|retainer) (has been |is )?paid/i,
  /(your |the )?booking (is )?confirmed/i,
  /(officially|finally) booked (the (date|venue|wedding)|with you|with us)/i,
  /(we're|we are|we have|i have) (officially )?booked (the (date|venue|wedding)|with)/i,
  /(we'd|we would|we'll) like to book (the (date|venue|wedding)|with)/i,
  /(?:wedding|date|contract|venue) (is |has been )?locked in/i,
  /locked in (the |a |my |our )(wedding|date|contract|venue)/i,
  /wire (sent|has been sent) for (the |your |our )(deposit|retainer|venue|wedding)/i,
  /(signed|returned|countersigned) (the |your |our )(contract|agreement)/i,
  /(let's|lets) (make it|lock it|get it) official.{0,30}(wedding|date|venue|book)/i,
  // HoneyBook / Dubsado / generic CRM notifications — these are unambiguous
  /(contract|proposal) (was |has been )?(accepted|signed|countersigned)/i,
  /proposal (accepted|signed|has been accepted)/i,
  /project (has been )?booked/i,
  /new booking (from|for)/i,
  // Payment signals — tightened to require event/wedding/venue context
  /payment (received|processed|confirmed|completed) for (the |your |our )(deposit|retainer|venue|wedding|booking)/i,
  /(deposit|retainer) (invoice|payment) (paid|has been paid|was paid)/i,
  /(received|processed) (a |the |your )(deposit|retainer) payment/i,
  /\$\d[\d,]*(\.\d\d)? (deposit|retainer)/i,
]

export const DATE_SPECIFICITY = /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4})/i

/**
 * Strip quoted reply chains from an email body before signal matching.
 *
 * Without this, booking-pattern regexes match against the venue's own
 * outbound copy that's quoted at the bottom of the couple's reply. The
 * Millaka case (2026-04-24): Sage sent "your 10% discount is locked in"
 * to Milla, Milla replied, the reply's body contained Sage's quoted text,
 * and BOOKING_PATTERNS matched "locked in" → wedding moved to 'booked'.
 *
 * Handles three quote styles:
 *   1. "On {date}, {name} <{email}> wrote:" — Gmail / most clients
 *   2. ">" prefixed lines — RFC plain-text reply quoting
 *   3. <blockquote class="gmail_quote"> — Gmail HTML reply
 *   4. "From: ... Sent: ... To: ..." — Outlook header block
 *
 * Returns the body with everything from the first quote marker onward
 * removed. If no quote marker is found, returns the body unchanged.
 */
export function stripQuotedReply(body: string): string {
  if (!body) return body
  let cutoff = body.length

  // Pattern 1: "On <date>, <name> wrote:" — case insensitive
  const onWrote = body.search(/\bOn .{1,200}wrote:/i)
  if (onWrote !== -1) cutoff = Math.min(cutoff, onWrote)

  // Pattern 2: HTML blockquote (Gmail quoted reply)
  const blockquote = body.search(/<blockquote[^>]*class=["']?gmail_quote/i)
  if (blockquote !== -1) cutoff = Math.min(cutoff, blockquote)

  // Pattern 3: Outlook header block — "From: ... To: ..." or "-----Original Message-----"
  const original = body.search(/-----Original Message-----|^\s*From:\s+.+(\r?\n)\s*Sent:\s+.+/im)
  if (original !== -1) cutoff = Math.min(cutoff, original)

  // Pattern 4: ">" prefix block — find the FIRST line that starts with ">"
  // followed by another quoted-or-prefix line. Single ">" lines in middle
  // of prose are common (e.g. literal quote of an idea), so require at
  // least two consecutive ">"-prefixed lines to count as a quote chain.
  const lines = body.split(/\r?\n/)
  let runStart = -1
  let charIdx = 0
  for (let i = 0; i < lines.length; i++) {
    const isQuoted = /^\s*>/.test(lines[i])
    if (isQuoted) {
      if (runStart === -1) runStart = charIdx
      // If we've seen 2+ consecutive quoted lines, treat from runStart on
      // as quoted material.
      const next = i + 1 < lines.length && /^\s*>/.test(lines[i + 1])
      if (next) {
        cutoff = Math.min(cutoff, runStart)
        break
      }
    } else {
      runStart = -1
    }
    charIdx += lines[i].length + 1 // +1 for newline
  }

  return body.slice(0, cutoff)
}

// ---------------------------------------------------------------------------
// Main entrypoint — run inference on a wedding's full thread
// ---------------------------------------------------------------------------

/**
 * Apply all pattern inferences to a single wedding, firing any new
 * engagement events + advancing status when triggered. Safe to call on
 * every inbound — dedupes via metadata.source + interaction_id.
 *
 * Returns a summary so the caller can log which signals fired.
 */
export async function applySignalInference(
  venueId: string,
  weddingId: string
): Promise<{
  newEvents: number
  newStatus: string | null
  fired: string[]
}> {
  const sb = createServiceClient()

  const [{ data: wedding }, { data: ints }, { data: existingEvents }] =
    await Promise.all([
      sb.from('weddings').select('status, source').eq('id', weddingId).maybeSingle(),
      sb
        .from('interactions')
        .select('id, direction, timestamp, subject, body_preview, full_body')
        .eq('wedding_id', weddingId)
        .order('timestamp', { ascending: true }),
      sb
        .from('engagement_events')
        .select('event_type, metadata')
        .eq('wedding_id', weddingId),
    ])

  if (!wedding || !ints || ints.length === 0) {
    return { newEvents: 0, newStatus: null, fired: [] }
  }

  const seen = {
    tour_requested: new Set<string>(),
    tour_scheduled: new Set<string>(),
    contract_sent: new Set<string>(),
    contract_signed: new Set<string>(),
    specificity_fired: false,
    sustained_fired: false,
    commitment_fired: false,
    reply_received: new Set<string>(),
  }
  for (const e of (existingEvents ?? []) as Array<{ event_type: string; metadata: Record<string, unknown> | null }>) {
    const iid = (e.metadata?.interaction_id as string | undefined) ?? null
    // Dedup by (event_type, interaction_id) for per-interaction events,
    // and by event_type alone for fire-once-per-wedding events.
    if (e.event_type === 'tour_requested' && iid) seen.tour_requested.add(iid)
    if (e.event_type === 'tour_scheduled' && iid) seen.tour_scheduled.add(iid)
    if (e.event_type === 'contract_sent' && iid) seen.contract_sent.add(iid)
    if (e.event_type === 'contract_signed' && iid) seen.contract_signed.add(iid)
    if (e.event_type === 'email_reply_received' && iid) seen.reply_received.add(iid)
    if (e.event_type === 'high_specificity') seen.specificity_fired = true
    if (e.event_type === 'sustained_engagement') seen.sustained_fired = true
    if (e.event_type === 'high_commitment_signal') seen.commitment_fired = true
  }

  const interactions = ints as Array<{
    id: string
    direction: 'inbound' | 'outbound'
    timestamp: string
    subject: string | null
    body_preview: string | null
    full_body: string | null
  }>

  const inbound = interactions.filter((i) => i.direction === 'inbound')
  const outbound = interactions.filter((i) => i.direction === 'outbound')

  const events: Array<{ eventType: string; metadata: Record<string, unknown>; occurredAt: string }> = []
  const fired: string[] = []

  let targetStatus: string | null = null
  const currentStatus = wedding.status as string
  const isTerminal = currentStatus === 'lost' || currentStatus === 'cancelled'

  // 1. Reply-volume — every inbound after the first
  for (let idx = 1; idx < inbound.length; idx++) {
    const i = inbound[idx]
    if (seen.reply_received.has(i.id)) continue
    events.push({
      eventType: 'email_reply_received',
      metadata: { interaction_id: i.id, source: 'signal_inference_reply' },
      occurredAt: i.timestamp,
    })
  }
  if (events.length > 0) fired.push(`${events.length} reply`)

  // 2. Tour request (inbound)
  for (const i of inbound) {
    if (seen.tour_requested.has(i.id)) continue
    const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
    if (TOUR_REQUEST_PATTERNS.some((r) => r.test(hay))) {
      events.push({
        eventType: 'tour_requested',
        metadata: { interaction_id: i.id, source: 'signal_inference_tour_request' },
        occurredAt: i.timestamp,
      })
      fired.push('tour_requested')
      break
    }
  }

  // 3. Tour confirmation (outbound → advances to tour_scheduled)
  for (const i of outbound) {
    if (seen.tour_scheduled.has(i.id)) continue
    const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
    if (TOUR_CONFIRMATION_PATTERNS.some((r) => r.test(hay))) {
      events.push({
        eventType: 'tour_scheduled',
        metadata: { interaction_id: i.id, source: 'signal_inference_tour_confirm' },
        occurredAt: i.timestamp,
      })
      fired.push('tour_scheduled')
      if (!isTerminal && currentStatus === 'inquiry') targetStatus = 'tour_scheduled'
      break
    }
  }

  // 4. Proposal sent (outbound → advances to proposal_sent)
  for (const i of outbound) {
    if (seen.contract_sent.has(i.id)) continue
    const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
    if (PROPOSAL_SENT_PATTERNS.some((r) => r.test(hay))) {
      events.push({
        eventType: 'contract_sent',
        metadata: { interaction_id: i.id, source: 'signal_inference_proposal' },
        occurredAt: i.timestamp,
      })
      fired.push('contract_sent')
      if (!isTerminal && (currentStatus === 'inquiry' || currentStatus === 'tour_scheduled')) {
        targetStatus = 'proposal_sent'
      }
      break
    }
  }

  // 5. Booking confirmed (either direction → advances to booked)
  for (const i of interactions) {
    if (seen.contract_signed.has(i.id)) continue
    const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
    if (BOOKING_PATTERNS.some((r) => r.test(hay))) {
      events.push({
        eventType: 'contract_signed',
        metadata: { interaction_id: i.id, source: 'signal_inference_booking' },
        occurredAt: i.timestamp,
      })
      fired.push('contract_signed')
      if (!isTerminal) targetStatus = 'booked'
      break
    }
  }

  // 6. Date specificity — one per wedding, fire once
  if (!seen.specificity_fired) {
    for (const i of inbound) {
      const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
      if (DATE_SPECIFICITY.test(hay)) {
        events.push({
          eventType: 'high_specificity',
          metadata: { interaction_id: i.id, source: 'signal_inference_date' },
          occurredAt: i.timestamp,
        })
        fired.push('date_specificity')
        break
      }
    }
  }

  // 7. Thread depth — 5+ inbound emails = sustained engagement
  if (!seen.sustained_fired && inbound.length >= 5) {
    const last = inbound[inbound.length - 1]
    events.push({
      eventType: 'sustained_engagement',
      metadata: {
        inbound_count: inbound.length,
        source: 'signal_inference_thread_depth',
      },
      occurredAt: last.timestamp,
    })
    fired.push('sustained_engagement')
  }

  // 8. Coordinator investment — 3+ outbound replies = coordinator has
  // decided this lead is worth pursuing, which itself is signal.
  if (!seen.commitment_fired && outbound.length >= 3) {
    const last = outbound[outbound.length - 1]
    events.push({
      eventType: 'high_commitment_signal',
      metadata: {
        outbound_count: outbound.length,
        source: 'signal_inference_investment',
      },
      occurredAt: last.timestamp,
    })
    fired.push('coordinator_investment')
  }

  if (events.length === 0 && !targetStatus) {
    return { newEvents: 0, newStatus: null, fired: [] }
  }

  // Single batch write + single recalc
  if (events.length > 0) {
    await recordEngagementEventsBatch(venueId, weddingId, events)
    // Mirror to wedding_touchpoints. The source is the wedding's first-
    // touch source (this email arrived via the same channel that brought
    // the inquiry — Knot relay, direct email, etc.). engagementToTouchType
    // skips heat-internal signals (specificity, sustained engagement)
    // automatically; only attribution-relevant funnel events land here.
    try {
      const { recordTouchpointsForEngagementEvents } = await import('@/lib/services/touchpoints')
      const inferredSource = (wedding as { source?: string | null }).source ?? null
      await recordTouchpointsForEngagementEvents(
        venueId,
        weddingId,
        events.map((e) => ({
          eventType: e.eventType,
          source: inferredSource,
          occurredAt: e.occurredAt,
          metadata: e.metadata,
        }))
      )
    } catch (err) {
      console.warn('[signal-inference] touchpoint mirror failed:', err)
    }
  }
  if (targetStatus && targetStatus !== currentStatus) {
    await sb.from('weddings').update({ status: targetStatus }).eq('id', weddingId)
    // Status-change touchpoint — proposal_sent / contract_signed can be
    // inferred from text patterns even when no scheduling event fires.
    // Source = wedding's first-touch source (the inquiry channel).
    try {
      const { recordStatusChangeTouchpoint } = await import('@/lib/services/touchpoints')
      const inferredSource = (wedding as { source?: string | null }).source ?? null
      await recordStatusChangeTouchpoint(venueId, weddingId, targetStatus, {
        source: inferredSource,
        medium: 'signal_inference',
      })
    } catch (err) {
      console.warn('[signal-inference] status-change touchpoint failed:', err)
    }
  }

  return { newEvents: events.length, newStatus: targetStatus, fired }
}
