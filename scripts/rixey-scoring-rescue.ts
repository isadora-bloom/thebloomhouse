// Tactical scoring rescue for Rixey (and any venue) after the
// email backfill. The classifier-only path under-credits real
// engagement. This script post-hoc infers signals from the text
// already in `interactions` and fires the matching heat events
// with occurred_at stamped at the real email timestamp so decay
// ages correctly.
//
// Signals inferred here (all cap to 100 via recalculateHeatScore):
//   1. Reply volume — every inbound after the first initial
//      inquiry → email_reply_received (+15) at the email's real
//      timestamp.
//   2. Tour confirmations — explicit patterns in outbound body
//      ("your tour is confirmed" / "see you on [date]" / "looking
//      forward to meeting you") → tour_scheduled (+20) + status
//      advance from 'inquiry' to 'tour_scheduled'.
//   3. Tour requests from inbound — "would love to tour" / "can
//      we come see" / "available to visit" → tour_requested (+15).
//   4. Booking confirmations — "contract signed" / "deposit paid"
//      / "officially booked" / "we're booked" → contract_signed
//      (+50) + status advance to 'booked'.
//   5. Date-specificity — inbound body mentions a specific date
//      pattern → high_specificity (+5) once per wedding.
//   6. Thread depth — wedding has ≥5 inbound emails → sustained
//      engagement: +5 per inbound beyond the first five, capped.
//   7. Coordinator investment — wedding has ≥3 outbound replies
//      from the team → high_commitment_signal (+10). A coordinator
//      writing three emails to a lead is signal the lead is real.
//
// Every synthetic event tags metadata.source so re-runs detect and
// skip duplicates. Status advances are gated — we never downgrade
// lost/cancelled back to active.
//
// Usage:
//   npx tsx scripts/rixey-scoring-rescue.ts                 # dry-run Rixey
//   npx tsx scripts/rixey-scoring-rescue.ts --apply         # execute Rixey
//   npx tsx scripts/rixey-scoring-rescue.ts --apply --venue <uuid>
//   npx tsx scripts/rixey-scoring-rescue.ts --apply --all   # every real venue
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { recalculateHeatScore } from '../src/lib/services/heat-mapping'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    })
)
for (const k of Object.keys(env)) {
  if (!process.env[k]) process.env[k] = env[k]
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const ALL = process.argv.includes('--all')
const venueIdx = process.argv.indexOf('--venue')
const CLI_VENUE = venueIdx >= 0 ? process.argv[venueIdx + 1] : null

// Expanded tour-confirmation patterns (coordinator → couple).
// Each regex proven false-positive-safe: "see you on" only matches
// when followed by a weekday or a date pattern; "tour" patterns are
// anchored with context words.
const TOUR_CONFIRMATION_PATTERNS: RegExp[] = [
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

// Tour-request patterns from inbound (couple → coordinator).
const TOUR_REQUEST_PATTERNS: RegExp[] = [
  /(would |we'd |i'd |love to |want to )?(tour|come (see|visit)|schedule a (tour|visit|viewing))/i,
  /available (to|for a) (tour|visit)/i,
  /can we (come |visit|tour|see)/i,
  /set up a tour/i,
  /book a (tour|visit|viewing)/i,
  /tour (availability|dates|times|times?)/i,
  /(when|what|times?|days?) (is|are) (the |your )?(tour|visits?) available/i,
  /come and (see|visit|tour)/i,
  /swing by/i,
  /visit the venue/i,
  /check out (your|the) venue/i,
]

// Booking-confirmed patterns. Tighter — want to minimise false positives
// since status→booked is a big state change. Includes HoneyBook + Dubsado
// + payment-platform language because those emails DO make it through the
// filter (HoneyBook is no_draft, not ignore).
const BOOKING_PATTERNS: RegExp[] = [
  /contract (is |has been )?signed/i,
  /(deposit|retainer) (has been |is )?paid/i,
  /booking (is )?confirmed/i,
  /officially booked/i,
  /(we're|we are|we have|i have) booked/i,
  /we'd like to book/i,
  /locked (it |the date )?in/i,
  /wire (sent|has been sent)/i,
  /(signed|returned|countersigned) (the |your )?contract/i,
  /(let's|lets) (make it|lock it|get it) official/i,
  // HoneyBook / Dubsado / generic CRM notifications
  /(contract|proposal) (was |has been )?(accepted|signed|countersigned)/i,
  /proposal (accepted|signed|has been accepted)/i,
  /project (has been )?booked/i,
  /new booking (from|for)/i,
  // Payment signals
  /payment (received|processed|confirmed|completed)/i,
  /invoice (paid|has been paid|was paid)/i,
  /(received|processed) (a |your )?payment/i,
  /\$\d[\d,]*(\.\d\d)? (received|paid|deposited|processed)/i,
  /you('ve| have) been paid/i,
]

// Proposal/contract-sent — an intermediate state between tour and booked.
// Coordinator has sent a contract. Lead is close. Advance status to
// 'proposal_sent' and fire contract_sent event (+30).
const PROPOSAL_SENT_PATTERNS: RegExp[] = [
  /contract (has been |was |is being )?sent/i,
  /proposal (has been |was )?sent/i,
  /(sent|attached) (the |a |your )?(contract|proposal|agreement)/i,
  /please find (the |your )?(contract|proposal|agreement)/i,
  /invoice (has been |was )?sent/i,
  /here('s| is) (the |your )?(contract|proposal|agreement)/i,
]

// Date-specificity: a proper date reference in email body.
// ISO (YYYY-MM-DD), slash (M/D/YY or M/D/YYYY), or "Month Day Year".
const DATE_SPECIFICITY = /(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4})/i

// ---------------------------------------------------------------------------
// Core rescue for one venue
// ---------------------------------------------------------------------------

async function rescueVenue(venueId: string) {
  console.log(`\n======================================`)
  console.log(`Venue ${venueId.slice(0, 8)} — ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`======================================`)

  const { data: weddings } = await sb
    .from('weddings')
    .select('id, status, heat_score, temperature_tier')
    .eq('venue_id', venueId)
  const wIds = (weddings ?? []).map((w: any) => w.id)
  if (wIds.length === 0) {
    console.log('  no weddings — skipping.')
    return
  }

  const { data: allInts } = await sb
    .from('interactions')
    .select('id, wedding_id, direction, timestamp, subject, body_preview, full_body')
    .eq('venue_id', venueId)
    .in('wedding_id', wIds)
    .order('timestamp', { ascending: true })

  const { data: existingEvents } = await sb
    .from('engagement_events')
    .select('wedding_id, event_type, metadata')
    .eq('venue_id', venueId)

  // Dedup keys for each event type we write.
  const seen = {
    reply: new Set<string>(),
    tour_scheduled: new Set<string>(),
    tour_requested: new Set<string>(),
    contract_sent: new Set<string>(),
    contract_signed: new Set<string>(),
    specificity: new Set<string>(),
    sustained: new Set<string>(),
    commitment: new Set<string>(),
  }
  for (const e of (existingEvents ?? []) as any[]) {
    const wid = e.wedding_id as string
    const iid = e.metadata?.interaction_id as string | undefined
    const src = e.metadata?.source as string | undefined
    if (e.event_type === 'email_reply_received' && iid) seen.reply.add(`${wid}:${iid}`)
    if (e.event_type === 'tour_scheduled' && iid) seen.tour_scheduled.add(`${wid}:${iid}`)
    if (e.event_type === 'tour_requested' && iid) seen.tour_requested.add(`${wid}:${iid}`)
    if (e.event_type === 'contract_sent' && iid) seen.contract_sent.add(`${wid}:${iid}`)
    if (e.event_type === 'contract_signed' && iid) seen.contract_signed.add(`${wid}:${iid}`)
    if (e.event_type === 'high_specificity' && src === 'scoring_rescue_date') seen.specificity.add(wid)
    if (e.event_type === 'sustained_engagement') seen.sustained.add(wid)
    if (e.event_type === 'high_commitment_signal' && src === 'scoring_rescue_investment') seen.commitment.add(wid)
  }

  const newEvents: Array<{
    venue_id: string
    wedding_id: string
    event_type: string
    points: number
    metadata: Record<string, unknown>
    occurred_at: string
  }> = []

  const statusTour = new Set<string>()
  const statusProposalSent = new Set<string>()
  const statusBooked = new Set<string>()

  // Bucket interactions per wedding
  const perWedding: Record<string, { inbound: any[]; outbound: any[] }> = {}
  for (const i of (allInts ?? []) as any[]) {
    if (!i.wedding_id) continue
    if (!perWedding[i.wedding_id]) perWedding[i.wedding_id] = { inbound: [], outbound: [] }
    perWedding[i.wedding_id][i.direction === 'inbound' ? 'inbound' : 'outbound'].push(i)
  }

  for (const [wid, { inbound, outbound }] of Object.entries(perWedding)) {
    // FIX 1 — reply-volume
    for (let idx = 1; idx < inbound.length; idx++) {
      const i = inbound[idx]
      if (seen.reply.has(`${wid}:${i.id}`)) continue
      newEvents.push({
        venue_id: venueId,
        wedding_id: wid,
        event_type: 'email_reply_received',
        points: 15,
        metadata: { interaction_id: i.id, source: 'scoring_rescue_reply' },
        occurred_at: i.timestamp,
      })
    }

    // FIX 2 — tour confirmation (scan outbound)
    for (const i of outbound) {
      if (seen.tour_scheduled.has(`${wid}:${i.id}`)) continue
      const hay = `${i.subject ?? ''}\n${i.full_body ?? i.body_preview ?? ''}`
      if (TOUR_CONFIRMATION_PATTERNS.some((r) => r.test(hay))) {
        newEvents.push({
          venue_id: venueId,
          wedding_id: wid,
          event_type: 'tour_scheduled',
          points: 20,
          metadata: { interaction_id: i.id, source: 'scoring_rescue_tour_confirm' },
          occurred_at: i.timestamp,
        })
        statusTour.add(wid)
        break // one tour_scheduled event per wedding is enough
      }
    }

    // FIX 3 — tour request (scan inbound)
    for (const i of inbound) {
      if (seen.tour_requested.has(`${wid}:${i.id}`)) continue
      const hay = `${i.subject ?? ''}\n${i.full_body ?? i.body_preview ?? ''}`
      if (TOUR_REQUEST_PATTERNS.some((r) => r.test(hay))) {
        newEvents.push({
          venue_id: venueId,
          wedding_id: wid,
          event_type: 'tour_requested',
          points: 15,
          metadata: { interaction_id: i.id, source: 'scoring_rescue_tour_request' },
          occurred_at: i.timestamp,
        })
        break
      }
    }

    // FIX 4a — contract sent (proposal_sent status). Intermediate step
    // between tour and booked — coordinator sent an offer. Scanned on
    // outbound only since this is venue-initiated.
    for (const i of outbound) {
      if (seen.contract_sent.has(`${wid}:${i.id}`)) continue
      const hay = `${i.subject ?? ''}\n${i.full_body ?? i.body_preview ?? ''}`
      if (PROPOSAL_SENT_PATTERNS.some((r) => r.test(hay))) {
        newEvents.push({
          venue_id: venueId,
          wedding_id: wid,
          event_type: 'contract_sent',
          points: 30,
          metadata: { interaction_id: i.id, source: 'scoring_rescue_proposal' },
          occurred_at: i.timestamp,
        })
        statusProposalSent.add(wid)
        break
      }
    }

    // FIX 4b — booking confirmed (either direction)
    for (const i of [...inbound, ...outbound]) {
      if (seen.contract_signed.has(`${wid}:${i.id}`)) continue
      const hay = `${i.subject ?? ''}\n${i.full_body ?? i.body_preview ?? ''}`
      if (BOOKING_PATTERNS.some((r) => r.test(hay))) {
        newEvents.push({
          venue_id: venueId,
          wedding_id: wid,
          event_type: 'contract_signed',
          points: 50,
          metadata: { interaction_id: i.id, source: 'scoring_rescue_booking' },
          occurred_at: i.timestamp,
        })
        statusBooked.add(wid)
        break
      }
    }

    // FIX 5 — date specificity (inbound mentions a real date)
    if (!seen.specificity.has(wid)) {
      for (const i of inbound) {
        const hay = `${i.subject ?? ''}\n${i.full_body ?? i.body_preview ?? ''}`
        if (DATE_SPECIFICITY.test(hay)) {
          newEvents.push({
            venue_id: venueId,
            wedding_id: wid,
            event_type: 'high_specificity',
            points: 5,
            metadata: { interaction_id: i.id, source: 'scoring_rescue_date' },
            occurred_at: i.timestamp,
          })
          break
        }
      }
    }

    // FIX 6 — thread depth (≥5 inbound messages)
    if (!seen.sustained.has(wid) && inbound.length >= 5) {
      const last = inbound[inbound.length - 1]
      newEvents.push({
        venue_id: venueId,
        wedding_id: wid,
        event_type: 'sustained_engagement',
        points: Math.min(15, (inbound.length - 4) * 3),
        metadata: {
          inbound_count: inbound.length,
          source: 'scoring_rescue_thread_depth',
        },
        occurred_at: last.timestamp,
      })
    }

    // FIX 7 — coordinator investment (≥3 outbound replies)
    if (!seen.commitment.has(wid) && outbound.length >= 3) {
      const last = outbound[outbound.length - 1]
      newEvents.push({
        venue_id: venueId,
        wedding_id: wid,
        event_type: 'high_commitment_signal',
        points: 10,
        metadata: {
          outbound_count: outbound.length,
          source: 'scoring_rescue_investment',
        },
        occurred_at: last.timestamp,
      })
    }
  }

  // Summarise
  const byType: Record<string, number> = {}
  for (const e of newEvents) byType[e.event_type] = (byType[e.event_type] ?? 0) + 1
  console.log(`  weddings analysed: ${Object.keys(perWedding).length}`)
  console.log(`  new events to insert: ${newEvents.length}`)
  for (const [t, n] of Object.entries(byType)) console.log(`    ${t.padEnd(26)} ${n}`)
  console.log(`  status → tour_scheduled: ${statusTour.size}`)
  console.log(`  status → proposal_sent:  ${statusProposalSent.size}`)
  console.log(`  status → booked:         ${statusBooked.size}`)

  if (!APPLY) return

  // Insert events in chunks
  for (let i = 0; i < newEvents.length; i += 200) {
    const chunk = newEvents.slice(i, i + 200)
    const { error } = await sb.from('engagement_events').insert(chunk)
    if (error) {
      console.error('  insert error:', error.message)
      return
    }
  }
  console.log(`  inserted ${newEvents.length} events.`)

  // Status advances — apply highest-priority state FIRST so earlier
  // states don't stomp a more-progressed wedding.
  //   booked > proposal_sent > tour_scheduled > inquiry
  if (statusBooked.size > 0) {
    const { error } = await sb
      .from('weddings')
      .update({ status: 'booked' })
      .in('id', Array.from(statusBooked))
      .not('status', 'in', '("lost","cancelled")')
    if (error) console.error('  booked status update error:', error.message)
  }
  if (statusProposalSent.size > 0) {
    // Only advance inquiry / tour_scheduled — don't demote a booked one
    const { error } = await sb
      .from('weddings')
      .update({ status: 'proposal_sent' })
      .in('id', Array.from(statusProposalSent))
      .in('status', ['inquiry', 'tour_scheduled'])
    if (error) console.error('  proposal_sent update error:', error.message)
  }
  if (statusTour.size > 0) {
    const { error } = await sb
      .from('weddings')
      .update({ status: 'tour_scheduled' })
      .in('id', Array.from(statusTour))
      .eq('status', 'inquiry')
    if (error) console.error('  tour_scheduled update error:', error.message)
  }

  // Recalc every wedding to pick up the new events
  let changed = 0
  for (const w of (weddings ?? []) as any[]) {
    try {
      const r = await recalculateHeatScore(venueId, w.id)
      if (r.newScore !== (w.heat_score ?? 0)) changed++
    } catch (err) {
      console.error(`  recalc ${w.id.slice(0, 8)}:`, (err as Error).message)
    }
  }
  console.log(`  recalculated ${weddings?.length}; ${changed} scores changed.`)

  const { data: after } = await sb
    .from('weddings')
    .select('temperature_tier, status')
    .eq('venue_id', venueId)
  const tiers: Record<string, number> = {}
  const statuses: Record<string, number> = {}
  for (const w of (after ?? []) as any[]) {
    tiers[w.temperature_tier ?? '(null)'] = (tiers[w.temperature_tier ?? '(null)'] ?? 0) + 1
    statuses[w.status ?? '(null)'] = (statuses[w.status ?? '(null)'] ?? 0) + 1
  }
  console.log(`  Post-rescue tiers:    ${JSON.stringify(tiers)}`)
  console.log(`  Post-rescue statuses: ${JSON.stringify(statuses)}`)
}

async function main() {
  let venueIds: string[] = [CLI_VENUE ?? RIXEY]
  if (ALL) {
    const { data: vs } = await sb.from('venues').select('id, is_demo').eq('is_demo', false)
    venueIds = (vs ?? []).map((v: any) => v.id)
    console.log(`--all: rescuing ${venueIds.length} non-demo venue(s)`)
  }
  for (const vid of venueIds) {
    await rescueVenue(vid)
  }
}

main().catch((err) => {
  console.error('Rescue failed:', err)
  process.exit(1)
})
