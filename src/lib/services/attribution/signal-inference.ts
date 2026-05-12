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
import { venueOwnEmails } from '@/lib/services/email/pipeline'

/**
 * Wave 9 — derive the canonical touchpoint source from an interaction's
 * from_email domain. Mirrors the known-domain map in data-integrity.ts
 * checkSourceConsistency so detector + writer stay in sync.
 *
 * Returns null when the email is missing or carries no platform-domain
 * signal (e.g. plain gmail.com / outlook.com), letting the caller fall
 * back to the wedding's legacy first-touch source as a courtesy.
 */
const WAVE9_KNOWN_SOURCE_DOMAINS: Record<string, string> = {
  '@calendly.com': 'calendly',
  '@calendlymail.com': 'calendly',
  '@acuityscheduling.com': 'acuity',
  '@honeybook.com': 'honeybook',
  '@dubsado.com': 'dubsado',
  '@theknot.com': 'the_knot',
  '@knotemail.com': 'the_knot',
  '@weddingwire.com': 'wedding_wire',
  '@herecomestheguide.com': 'here_comes_the_guide',
  '@zola.com': 'zola',
}

function deriveSourceFromEmail(fromEmail: string | null | undefined): string | null {
  if (!fromEmail) return null
  const lower = fromEmail.toLowerCase()
  for (const [domain, src] of Object.entries(WAVE9_KNOWN_SOURCE_DOMAINS)) {
    if (lower.includes(domain)) return src
  }
  return null
}

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
  // 2026-05-01: tightened — the original `(would|we'd|i'd|...)?` made
  // every prefix optional, so a bare 'tour' word matched. "Please cancel
  // our tour" was a false-positive tour_request. Now an explicit intent
  // token is required.
  /(?:would|we'd|i'd|love to|want to|we want to|we'd love to|we would like to|i would like to) (?:to )?(?:tour|come (?:see|visit)|schedule a (?:tour|visit|viewing))/i,
  /available (?:to|for a) (?:tour|visit)/i,
  /can we (?:come|visit|tour|see)/i,
  /set up a tour/i,
  /book a (?:tour|visit|viewing)/i,
  /tour (?:availability|dates|times?)/i,
  /(?:when|what|times?|days?) (?:is|are) (?:the |your )?(?:tour|visits?) available/i,
  /come and (?:see|visit|tour)/i,
  /swing by/i,
  /visit the venue/i,
  /check out (?:your|the) venue/i,
]

// Negative-intent patterns. Couple is signaling they will not be moving
// forward — going elsewhere, pausing, declining the proposal, no longer
// interested. Fires not_interested_signal (-25 heat) + a coordinator
// alert. The patterns are conservative — false-positives cost the
// venue real attention and an unnecessary "lead at risk" alert, so
// each pattern requires explicit rejection language, not ambiguous
// hesitation. Per heat-mapping DEFAULT_POINTS.not_interested_signal.
export const NOT_INTERESTED_PATTERNS: RegExp[] = [
  /(?:going|went|going to go) (?:with )?another (?:venue|option|place)/i,
  /going (?:in )?a different direction/i,
  /(?:decided|chose|chosen) (?:to go )?(?:with|on) another (?:venue|option|place)/i,
  /(?:we |we've |we have )(?:decided |chosen )?(?:to )?go (?:in )?a different (?:direction|way)/i,
  /(?:we |we've |we have )(?:decided not to|won't be) (?:moving|move) forward/i,
  /(?:we |we've |we have )(?:decided to )?(?:pause|hold off)/i,
  /(?:put|putting).{0,15}on hold/i,
  /no longer (?:interested|considering)/i,
  /not (?:going to be |)?(?:moving forward|booking|proceeding)/i,
  /(?:thanks|thank you).{0,40}(?:we['']?ve found|going with another|going elsewhere)/i,
  /(?:please )?(?:remove|removing) (?:us|our (?:names?|inquiry|interest)|me) from (?:your |the )?(?:list|consideration|inquir)/i,
  /(?:please )?(?:cancel|withdraw) (?:our|my|this) (?:inquiry|consideration|interest)/i,
  /(?:we['']ve|we have) (?:found|booked) (?:another|a different) venue/i,
  /(?:found|chose|chosen) (?:our )?venue (?:elsewhere|already)/i,
]

// Tour-cancellation patterns. When a couple writes "we need to cancel
// our tour" / "can't make it" / "won't be coming" — fires tour_cancelled
// alongside the existing scheduling-tool parser path so cancellations
// in plain email bodies don't silently miss the heat-score downgrade.
// Excludes ambiguous reschedule patterns (those have their own kind).
export const TOUR_CANCEL_PATTERNS: RegExp[] = [
  /(?:we |we'd |we will |i |we're going to )?(?:need|have) to cancel (?:our|the|my) tour/i,
  // "won't be able to make/attend [the] tour", "can't make/attend [the] tour"
  /(?:we |i )(?:can'?t|cannot|won'?t be (?:able )?(?:to))(?: )(?:make|attend|come (?:to|for) the)(?: the | a | )?(?:tour|visit|appointment)/i,
  /(?:tour|visit|appointment) (?:is|has been) cancell?ed/i,
  /(?:please )?cancel (?:our|the|my|this) (?:tour|visit|appointment)/i,
  /(?:we |we're |we are )(?:going to |will )?have to cancel/i,
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

  const [{ data: wedding }, { data: ints }, { data: existingEvents }, ownEmails] =
    await Promise.all([
      sb.from('weddings').select('status, source, lost_at').eq('id', weddingId).maybeSingle(),
      sb
        .from('interactions')
        .select('id, direction, timestamp, subject, body_preview, full_body, from_email')
        .eq('wedding_id', weddingId)
        .order('timestamp', { ascending: true }),
      sb
        .from('engagement_events')
        .select('event_type, metadata, occurred_at, created_at')
        .eq('wedding_id', weddingId),
      // Defensive: even if direction is wrong on legacy data, skipping
      // any interaction whose from_email belongs to the venue prevents
      // signal-inference from firing tour_requested / high_specificity
      // /etc on Sage's own marketing copy. Belt-and-suspenders.
      venueOwnEmails(venueId),
    ])

  if (!wedding || !ints || ints.length === 0) {
    return { newEvents: 0, newStatus: null, fired: [] }
  }

  // 2026-05-01 (heat-map fix): tour_requested + tour_scheduled are
  // FIRE-ONCE-PER-WEDDING by doctrine — a couple "asks for a tour" once,
  // and the venue "schedules" them once, even if the underlying
  // conversation continues for months and every reply mentions the
  // tour. Pre-fix the seen map was keyed by interaction_id which only
  // skipped the SAME interaction's id; a new interaction with the same
  // text pattern fired a fresh +15. Result on Courtney Heiner: 4×
  // tour_requested events from Mar 7 / Mar 14 / Mar 24 / Apr 26 replies,
  // each adding +15 to a heat score that should have been ~75.
  //
  // contract_sent + contract_signed stay per-interaction because the
  // venue may legitimately send multiple proposals (revised contract
  // on price changes, addendum on date moves) — each is a real signal.
  // reply_received also stays per-interaction (every reply is a real
  // engagement event).
  //
  // Negative-intent signals (not_interested_signal, tour_cancelled)
  // fire-once-per-wedding for the same reason — once the couple says
  // they're going elsewhere, repeating the message doesn't make it
  // -50, and hearing "I cancelled" twice doesn't deserve -30.
  // 2026-05-01 (review pass 2): reopen-aware dedup.
  //
  // If the wedding was marked lost (lost_at IS NOT NULL) and a
  // fire-once-per-wedding event predates lost_at, the lead has
  // since reopened — that old event shouldn't block a fresh fire on
  // the new conversation. Without this, a couple who declined 6 months
  // ago and just sent a fresh "we're back, can we tour?" wouldn't
  // refire tour_requested.
  //
  // Logic: an event "blocks" a future fire only if its occurred_at
  // (or created_at fallback) is AFTER the wedding's lost_at. If
  // lost_at is null (lead never went lost), all past events block —
  // matches the original fire-once-per-wedding behaviour.
  const lostAtMs = (wedding.lost_at as string | null)
    ? Date.parse(wedding.lost_at as string)
    : NaN
  const isStillBlocking = (e: { occurred_at: string | null; created_at: string | null }): boolean => {
    if (!Number.isFinite(lostAtMs)) return true  // no lost event → all past events block
    const t = e.occurred_at ?? e.created_at
    if (!t) return true  // no timestamp → conservative
    const tMs = Date.parse(t)
    if (!Number.isFinite(tMs)) return true
    // Event happened AFTER the lead went lost → it's part of the
    // current (post-reopen) window, still blocks. Event happened
    // BEFORE lost → it's stale, doesn't block.
    return tMs > lostAtMs
  }

  const seen = {
    tour_requested_fired: false,
    tour_scheduled_fired: false,
    tour_cancelled_fired: false,
    not_interested_fired: false,
    contract_sent: new Set<string>(),
    contract_signed: new Set<string>(),
    specificity_fired: false,
    sustained_fired: false,
    commitment_fired: false,
    reply_received: new Set<string>(),
  }
  for (const e of (existingEvents ?? []) as Array<{
    event_type: string
    metadata: Record<string, unknown> | null
    occurred_at: string | null
    created_at: string | null
  }>) {
    const iid = (e.metadata?.interaction_id as string | undefined) ?? null
    const blocks = isStillBlocking(e)

    if (blocks && e.event_type === 'tour_requested') seen.tour_requested_fired = true
    if (blocks && e.event_type === 'tour_scheduled') seen.tour_scheduled_fired = true
    if (blocks && e.event_type === 'tour_cancelled') seen.tour_cancelled_fired = true
    if (blocks && e.event_type === 'not_interested_signal') seen.not_interested_fired = true
    // contract_sent / contract_signed dedup is per-interaction-id, not
    // fire-once-per-wedding, so reopen-aware logic doesn't apply here.
    if (e.event_type === 'contract_sent' && iid) seen.contract_sent.add(iid)
    if (e.event_type === 'contract_signed' && iid) seen.contract_signed.add(iid)
    // T2-F: HoneyBook lifecycle equivalents. signed + payment both
    // count as contract_signed dedup signals so signal-inference
    // doesn't re-fire a contract_signed event from a generic email
    // body when the HoneyBook system already recorded the booking.
    if (e.event_type === 'honeybook_contract_signed' && iid) seen.contract_signed.add(iid)
    if (e.event_type === 'honeybook_payment_received' && iid) seen.contract_signed.add(iid)
    if (e.event_type === 'email_reply_received' && iid) seen.reply_received.add(iid)
    if (blocks && e.event_type === 'high_specificity') seen.specificity_fired = true
    if (blocks && e.event_type === 'sustained_engagement') seen.sustained_fired = true
    if (blocks && e.event_type === 'high_commitment_signal') seen.commitment_fired = true
  }

  const interactions = ints as Array<{
    id: string
    direction: 'inbound' | 'outbound'
    timestamp: string
    subject: string | null
    body_preview: string | null
    full_body: string | null
    from_email: string | null
  }>

  // 2026-04-30 defensive guard: legacy data has Sage outbounds
  // misclassified as direction='inbound' from the customer (the
  // backfill that captured Rixey's history pre-dated the SENT-label
  // direction check). Re-classify on read so signal-inference never
  // fires patterns on our own marketing copy regardless of stored
  // direction. The pipeline-side fix prevents new bad rows; this
  // guard handles the existing pile.
  const isVenueOwnSender = (i: { from_email: string | null }) =>
    Boolean(i.from_email && ownEmails.has(i.from_email.toLowerCase().trim()))
  const inbound = interactions.filter((i) => i.direction === 'inbound' && !isVenueOwnSender(i))
  const outbound = interactions.filter((i) => i.direction === 'outbound' || isVenueOwnSender(i))

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

  // 2. Tour request (inbound) — fire-once-per-wedding (2026-05-01 fix)
  if (!seen.tour_requested_fired) {
    for (const i of inbound) {
      const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
      if (TOUR_REQUEST_PATTERNS.some((r) => r.test(hay))) {
        events.push({
          eventType: 'tour_requested',
          metadata: { interaction_id: i.id, source: 'signal_inference_tour_request' },
          occurredAt: i.timestamp,
        })
        fired.push('tour_requested')
        seen.tour_requested_fired = true
        break
      }
    }
  }

  // 3. Tour confirmation (outbound → advances to tour_scheduled).
  // Fire-once-per-wedding (2026-05-01 fix). The Calendly / scheduling-
  // tool path also fires tour_scheduled when an actual booking event
  // hits — this signal-inference fallback only fires on plain-email
  // confirmations where no scheduling-tool fired.
  if (!seen.tour_scheduled_fired) {
    for (const i of outbound) {
      const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
      if (TOUR_CONFIRMATION_PATTERNS.some((r) => r.test(hay))) {
        events.push({
          eventType: 'tour_scheduled',
          metadata: { interaction_id: i.id, source: 'signal_inference_tour_confirm' },
          occurredAt: i.timestamp,
        })
        fired.push('tour_scheduled')
        seen.tour_scheduled_fired = true
        if (!isTerminal && currentStatus === 'inquiry') targetStatus = 'tour_scheduled'
        break
      }
    }
  }

  // 3a. Tour cancellation (inbound) — fires tour_cancelled (-15) +
  // sets a flag the caller will use to drop a coordinator alert.
  // 2026-05-01: closes the gap where a couple writes "we need to
  // cancel our tour" in plain email but no scheduling-tool email
  // fires (Calendly cancel email is the primary path; this is the
  // belt-and-braces text-pattern path). Fire-once-per-wedding.
  let firedTourCancelled = false
  if (!seen.tour_cancelled_fired) {
    for (const i of inbound) {
      const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
      if (TOUR_CANCEL_PATTERNS.some((r) => r.test(hay))) {
        events.push({
          eventType: 'tour_cancelled',
          metadata: { interaction_id: i.id, source: 'signal_inference_tour_cancel' },
          occurredAt: i.timestamp,
        })
        fired.push('tour_cancelled')
        seen.tour_cancelled_fired = true
        firedTourCancelled = true
        break
      }
    }
  }

  // 3b. Not-interested signal (inbound). Couple is signaling they
  // won't be moving forward — going elsewhere, declining, pausing.
  // Fires not_interested_signal (-25) + coordinator alert. Fire-
  // once-per-wedding.
  let firedNotInterested = false
  if (!seen.not_interested_fired) {
    for (const i of inbound) {
      const hay = `${i.subject ?? ''}\n${stripQuotedReply(i.full_body ?? i.body_preview ?? '')}`
      if (NOT_INTERESTED_PATTERNS.some((r) => r.test(hay))) {
        events.push({
          eventType: 'not_interested_signal',
          metadata: { interaction_id: i.id, source: 'signal_inference_not_interested' },
          occurredAt: i.timestamp,
        })
        fired.push('not_interested_signal')
        seen.not_interested_fired = true
        firedNotInterested = true
        break
      }
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

  // Single batch write + single recalc.
  // Direction: inbound. signal-inference fires from inbound classifier
  // output (sustained engagement on couple replies, etc.) — every
  // event here is observation of a couple-side action.
  //
  // Wave 9 root-cause fix (2026-05-10): build an interaction-id→
  // from_email lookup from the in-scope inbound + outbound arrays so
  // each touchpoint's source can be derived from the LINKED
  // INTERACTION's actual channel, not the wedding's legacy first-touch
  // source. The touchpoint_source_consistency invariant flags drift
  // when these disagree; this closes the write-site.
  const interactionById = new Map<string, { from_email: string | null }>()
  for (const i of ints as Array<{ id: string; from_email: string | null }>) {
    interactionById.set(i.id, { from_email: i.from_email })
  }
  if (events.length > 0) {
    await recordEngagementEventsBatch(venueId, weddingId, events, 'inbound')
    // Mirror to wedding_touchpoints. engagementToTouchType skips
    // heat-internal signals (specificity, sustained engagement)
    // automatically; only attribution-relevant funnel events land here.
    try {
      const { recordTouchpointsForEngagementEvents } = await import('@/lib/services/attribution/touchpoints')
      const legacyFallbackSource = (wedding as { source?: string | null }).source ?? null
      await recordTouchpointsForEngagementEvents(
        venueId,
        weddingId,
        events.map((e) => {
          const interactionId = typeof e.metadata?.interaction_id === 'string'
            ? e.metadata.interaction_id
            : null
          const linkedFromEmail = interactionId
            ? interactionById.get(interactionId)?.from_email ?? null
            : null
          const derivedSource = deriveSourceFromEmail(linkedFromEmail)
          return {
            eventType: e.eventType,
            // Prefer derived channel from the linked interaction; fall
            // back to wedding.source only when the interaction is
            // missing or carries no platform domain signal.
            source: derivedSource ?? legacyFallbackSource,
            occurredAt: e.occurredAt,
            metadata: e.metadata,
          }
        })
      )
    } catch (err) {
      console.warn('[signal-inference] touchpoint mirror failed:', err)
    }
  }
  if (targetStatus && targetStatus !== currentStatus) {
    await sb.from('weddings').update({ status: targetStatus }).eq('id', weddingId)

    // Cascade Pattern 2 (migration 307): lost-mark cascade. Trigger 307
    // handles draft cancellation Postgres-side; this fires the JS-side
    // heat recompute + lifecycle event row. Fire-and-forget.
    if (targetStatus === 'lost' && currentStatus !== 'lost') {
      void (async () => {
        try {
          const { triggerLostMarkCascade } = await import(
            '@/lib/services/cascades/on-lost-mark'
          )
          await triggerLostMarkCascade({
            venueId,
            weddingId,
            supabase: sb,
            reason: 'pipeline_signal',
          })
        } catch (err) {
          console.warn('[signal-inference] lost-mark cascade non-fatal:', err)
        }
      })()
    }

    // Status-change touchpoint — proposal_sent / contract_signed can be
    // inferred from text patterns even when no scheduling event fires.
    // Wave 9: derive from the latest event's linked interaction when
    // possible (proposal pattern fires from a specific outbound), fall
    // back to wedding.source.
    try {
      const { recordStatusChangeTouchpoint } = await import('@/lib/services/attribution/touchpoints')
      const legacyFallbackSource = (wedding as { source?: string | null }).source ?? null
      const latestEvent = events.length > 0 ? events[events.length - 1] : null
      const latestInteractionId = latestEvent && typeof latestEvent.metadata?.interaction_id === 'string'
        ? latestEvent.metadata.interaction_id
        : null
      const latestFromEmail = latestInteractionId
        ? interactionById.get(latestInteractionId)?.from_email ?? null
        : null
      const derivedSource = deriveSourceFromEmail(latestFromEmail)
      await recordStatusChangeTouchpoint(venueId, weddingId, targetStatus, {
        source: derivedSource ?? legacyFallbackSource,
        medium: 'signal_inference',
      })
    } catch (err) {
      console.warn('[signal-inference] status-change touchpoint failed:', err)
    }
  }

  // Coordinator alerts on negative-intent signals (2026-05-01 heat-map
  // fix). When a tour is cancelled or a couple signals they're not
  // moving forward, drop a 'lead_at_risk' notification so the
  // coordinator sees it on /agent/notifications. Idempotent via
  // createNotification's 5-minute dedup window per
  // (venue, wedding, type).
  if (firedTourCancelled || firedNotInterested) {
    try {
      const { createNotification } = await import('@/lib/services/admin-notifications')
      const reason = firedTourCancelled ? 'tour cancelled' : 'declined to move forward'
      const heatDelta = firedTourCancelled ? '-15' : '-25'
      await createNotification({
        venueId,
        weddingId,
        type: 'lead_at_risk',
        title: `Lead at risk: ${reason}`,
        body:
          `Signal-inference detected the couple ${reason} on this thread. ` +
          `Heat dropped by ${heatDelta} points. Open the lead and decide next steps ` +
          `(re-engagement, mark lost, or close out).`,
      })
    } catch (err) {
      console.warn('[signal-inference] lead_at_risk notification failed:', err)
    }
  }

  return { newEvents: events.length, newStatus: targetStatus, fired }
}
