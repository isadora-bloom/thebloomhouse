// Post-fix cleanup after the event-type + time-aware tour kind shipped:
//
//  1. Roll back the Millaka false-positive contract_signed event.
//     The old "locked in" pattern matched Sage's outbound copy
//     ("your 10% discount is already locked in") which isn't a
//     booking signal. The pattern is tightened in signal-inference.ts
//     but the existing event must be deleted and the wedding's
//     status reverted.
//
//  2. Re-walk every scheduling-tool engagement event and re-classify
//     based on the now-extracted event type + event datetime. A
//     tour_scheduled event whose datetime is past should be marked
//     tour_completed; a final_walkthrough event implies the wedding
//     should be at status='booked' already.
//
//  3. Recompute heat for every wedding touched.
//
// Idempotent — re-running just no-ops because event metadata gets
// re-classified every pass.
//
// Usage:
//   npx tsx scripts/fix-event-types-and-past-tours.ts                # dry-run Rixey
//   npx tsx scripts/fix-event-types-and-past-tours.ts --apply
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import {
  detectSchedulingEvent,
  eventKindToEngagementType,
  eventKindToStatus,
  timeAwareTourKind,
} from '../src/lib/services/scheduling-tool-parsers'
import {
  stripQuotedReply,
  BOOKING_PATTERNS,
  TOUR_CONFIRMATION_PATTERNS,
  TOUR_REQUEST_PATTERNS,
  PROPOSAL_SENT_PATTERNS,
} from '../src/lib/services/signal-inference'
import { recalculateHeatScore } from '../src/lib/services/heat-mapping'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
const APPLY = process.argv.includes('--apply')
const venueIdx = process.argv.indexOf('--venue')
const VENUE_ID = venueIdx >= 0 ? process.argv[venueIdx + 1] : RIXEY

const STATUS_RANK: Record<string, number> = {
  inquiry: 0, tour_scheduled: 1, tour_completed: 2, proposal_sent: 3, booked: 4,
  completed: 5, lost: 99, cancelled: 99,
}

async function main() {
  console.log(`Event-type + past-tours fix — ${APPLY ? 'APPLY' : 'DRY RUN'} — venue=${VENUE_ID.slice(0, 8)}`)

  // 1. Re-validate every signal-inference / scoring-rescue event against
  //    the NEW patterns + quoted-reply stripping. The Millaka-style bug
  //    fired booking events on inbound replies that quoted Sage's
  //    outbound marketing copy ("your 10% discount is locked in"). With
  //    stripQuotedReply, the quoted block is removed before pattern
  //    matching, so any event whose un-quoted body no longer matches the
  //    relevant pattern was a false positive that needs to be deleted.
  console.log('\n--- 1. Re-validate booking/tour signals against unquoted body ---')
  const PATTERN_BY_SOURCE: Record<string, RegExp[]> = {
    signal_inference_booking: BOOKING_PATTERNS,
    scoring_rescue_booking: BOOKING_PATTERNS,
    signal_inference_tour_confirm: TOUR_CONFIRMATION_PATTERNS,
    scoring_rescue_tour_confirm: TOUR_CONFIRMATION_PATTERNS,
    signal_inference_tour_request: TOUR_REQUEST_PATTERNS,
    scoring_rescue_tour_request: TOUR_REQUEST_PATTERNS,
    signal_inference_proposal: PROPOSAL_SENT_PATTERNS,
    scoring_rescue_proposal: PROPOSAL_SENT_PATTERNS,
  }
  const { data: candidateEvents } = await sb
    .from('engagement_events')
    .select('id, wedding_id, event_type, metadata')
    .eq('venue_id', VENUE_ID)
    .in('event_type', ['contract_signed', 'tour_scheduled', 'tour_requested', 'contract_sent'])
  console.log(`  candidate events: ${candidateEvents?.length ?? 0}`)
  const toRollBack: string[] = []
  const weddingsToRevert = new Set<string>()
  for (const ev of (candidateEvents ?? []) as any[]) {
    const src = ev.metadata?.source as string | undefined
    const iid = ev.metadata?.interaction_id as string | undefined
    if (!src || !iid) continue
    const patterns = PATTERN_BY_SOURCE[src]
    if (!patterns) continue // not a regex-derived event
    const { data: i } = await sb.from('interactions').select('subject, full_body, body_preview').eq('id', iid).maybeSingle()
    if (!i) continue
    const stripped = stripQuotedReply((i as any).full_body ?? (i as any).body_preview ?? '')
    const hay = `${(i as any).subject ?? ''}\n${stripped}`
    const stillMatches = patterns.some((r) => r.test(hay))
    if (!stillMatches) {
      toRollBack.push(ev.id)
      weddingsToRevert.add(ev.wedding_id)
      console.log(`    ROLLBACK ${ev.id.slice(0, 8)} (${ev.event_type} src=${src})  no longer matches after quote-strip`)
    }
  }
  if (APPLY && toRollBack.length > 0) {
    for (let i = 0; i < toRollBack.length; i += 100) {
      await sb.from('engagement_events').delete().in('id', toRollBack.slice(i, i + 100))
    }
    console.log(`  deleted ${toRollBack.length} false-positive events`)
    // Revert weddings whose ONLY contract_signed source was the deleted event
    for (const wid of weddingsToRevert) {
      const { count: csRemain } = await sb
        .from('engagement_events')
        .select('*', { count: 'exact', head: true })
        .eq('wedding_id', wid)
        .eq('event_type', 'contract_signed')
      if (csRemain === 0) {
        const { data: w } = await sb.from('weddings').select('status').eq('id', wid).maybeSingle()
        if (w && (w as any).status === 'booked') {
          await sb.from('weddings').update({ status: 'inquiry' }).eq('id', wid)
          console.log(`    reverted ${wid.slice(0, 8)} booked → inquiry (no remaining contract_signed)`)
        }
      }
    }
  }

  // 2. Re-walk Calendly-style interactions, reparse with the updated
  //    event-type-aware parser, and update existing engagement events
  //    + status when the kind has changed (e.g., tour_scheduled in the
  //    past should be tour_completed; final walkthroughs imply booked).
  console.log('\n--- 2. Re-classify scheduling events by event type + time ---')
  const { data: cands } = await sb
    .from('interactions')
    .select('id, wedding_id, timestamp, subject, body_preview, full_body, from_email')
    .eq('venue_id', VENUE_ID)
    .ilike('full_body', '%Invitee Email%')
  let reclassified = 0
  let upgraded = 0
  const weddingsTouched = new Set<string>()

  for (const c of (cands ?? []) as any[]) {
    const wid = c.wedding_id as string | null
    if (!wid) continue
    let event = detectSchedulingEvent({
      from: c.from_email ?? '',
      subject: c.subject ?? '',
      body: c.full_body ?? c.body_preview ?? '',
    })
    if (!event) continue
    const adjusted = timeAwareTourKind(event.kind, event.eventDatetime)
    if (adjusted !== event.kind) event = { ...event, kind: adjusted }

    const desiredEventType = eventKindToEngagementType(event.kind)
    const desiredStatus = eventKindToStatus(event.kind)

    // Find existing event tied to this interaction
    const { data: existing } = await sb
      .from('engagement_events')
      .select('id, event_type, metadata')
      .eq('wedding_id', wid)
      .filter('metadata->>interaction_id', 'eq', c.id)
      .limit(1)
    const existingEv = existing?.[0] as any | undefined

    if (existingEv && existingEv.event_type !== desiredEventType) {
      reclassified++
      console.log(`    reclass ${c.id.slice(0, 8)}: ${existingEv.event_type} → ${desiredEventType}  (${event.eventTypeName ?? '?'})`)
      if (APPLY) {
        await sb
          .from('engagement_events')
          .update({
            event_type: desiredEventType,
            metadata: { ...existingEv.metadata, scheduling_kind: event.kind, event_type_name: event.eventTypeName },
          })
          .eq('id', existingEv.id)
      }
    }

    // Status advance based on the (possibly upgraded) kind
    if (desiredStatus) {
      const { data: w } = await sb.from('weddings').select('status').eq('id', wid).maybeSingle()
      const cur = ((w as any)?.status as string) ?? 'inquiry'
      const curRank = STATUS_RANK[cur] ?? 0
      const tgtRank = STATUS_RANK[desiredStatus] ?? 0
      if (curRank < 99 && tgtRank > curRank) {
        upgraded++
        if (APPLY) {
          await sb.from('weddings').update({ status: desiredStatus }).eq('id', wid)
        }
      }
    }
    weddingsTouched.add(wid)
  }
  console.log(`  reclassified events:    ${reclassified}`)
  console.log(`  upgraded statuses:      ${upgraded}`)
  console.log(`  weddings touched:       ${weddingsTouched.size}`)

  // 3. Recalc all touched weddings
  if (APPLY) {
    console.log('\n--- 3. Recalculate heat ---')
    let heatChanged = 0
    for (const wid of weddingsTouched) {
      try {
        const r = await recalculateHeatScore(VENUE_ID, wid)
        if (r) heatChanged++
      } catch (err) {
        console.error(`  recalc ${wid.slice(0, 8)}:`, (err as Error).message)
      }
    }
    console.log(`  recalculated ${heatChanged} weddings`)
  }

  // Final state
  const { data: ws } = await sb.from('weddings').select('status, temperature_tier').eq('venue_id', VENUE_ID)
  const statusDist: Record<string, number> = {}
  const tierDist: Record<string, number> = {}
  for (const w of (ws ?? []) as any[]) {
    statusDist[w.status] = (statusDist[w.status] ?? 0) + 1
    tierDist[w.temperature_tier ?? '(null)'] = (tierDist[w.temperature_tier ?? '(null)'] ?? 0) + 1
  }
  console.log('\nFinal state:')
  console.log(`  status: ${JSON.stringify(statusDist)}`)
  console.log(`  tier:   ${JSON.stringify(tierDist)}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
