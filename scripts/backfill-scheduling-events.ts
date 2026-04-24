// Backfill scheduling-tool events (Calendly, Acuity, HoneyBook, Dubsado)
// on historical interactions that were ingested before
// scheduling-tool-parsers.ts was wired into the live pipeline.
//
// For every interaction whose sender domain matches a scheduling tool,
// reparse the body via detectSchedulingEvent, re-link the interaction to
// the correct wedding (via invitee email → people → weddings), fire the
// matching engagement_event, and advance status.
//
// White-label: works on any venue. --all to rescue every non-demo venue.
// Idempotent: dedupes by (wedding_id, interaction_id) on event type.
//
// Usage:
//   npx tsx scripts/backfill-scheduling-events.ts                # dry-run Rixey
//   npx tsx scripts/backfill-scheduling-events.ts --apply        # execute Rixey
//   npx tsx scripts/backfill-scheduling-events.ts --apply --all  # every real venue
//   npx tsx scripts/backfill-scheduling-events.ts --apply --venue <uuid>
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import {
  detectSchedulingEvent,
  eventKindToEngagementType,
  eventKindToStatus,
  type SchedulingEvent,
} from '../src/lib/services/scheduling-tool-parsers'
import { recordEngagementEventsBatch, recalculateHeatScore } from '../src/lib/services/heat-mapping'

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

const STATUS_RANK: Record<string, number> = {
  inquiry: 0, tour_scheduled: 1, tour_completed: 2, proposal_sent: 3, booked: 4,
  completed: 5, lost: 99, cancelled: 99,
}

interface InteractionRow {
  id: string
  wedding_id: string | null
  person_id: string | null
  timestamp: string
  subject: string | null
  body_preview: string | null
  full_body: string | null
  from_email: string | null
  from_name: string | null
}

async function findWeddingForInvitee(venueId: string, inviteeEmail: string): Promise<string | null> {
  // Strategy A: people.email + weddings.primary/partner1_person_id
  const { data: person } = await sb
    .from('people')
    .select('id')
    .eq('venue_id', venueId)
    .ilike('email', inviteeEmail)
    .limit(1)
    .maybeSingle()
  const personId = person?.id as string | undefined
  if (!personId) return null

  // Prefer the most recent wedding that has this person as primary / partner
  const { data: primaryWeddings } = await sb
    .from('weddings')
    .select('id, inquiry_date')
    .eq('venue_id', venueId)
    .or(`primary_person_id.eq.${personId},partner1_person_id.eq.${personId},partner2_person_id.eq.${personId}`)
    .order('inquiry_date', { ascending: false })
    .limit(1)
  if (primaryWeddings && primaryWeddings.length > 0) return primaryWeddings[0].id as string

  // Fallback: wedding_people junction table
  const { data: junction } = await sb
    .from('wedding_people')
    .select('wedding_id')
    .eq('person_id', personId)
    .limit(1)
  if (junction && junction.length > 0) return junction[0].wedding_id as string

  // Final fallback: any interaction for this person with a wedding_id
  const { data: pastInts } = await sb
    .from('interactions')
    .select('wedding_id')
    .eq('venue_id', venueId)
    .eq('person_id', personId)
    .not('wedding_id', 'is', null)
    .order('timestamp', { ascending: false })
    .limit(1)
  if (pastInts && pastInts.length > 0) return (pastInts[0].wedding_id as string | null) ?? null

  return null
}

async function runVenue(venueId: string) {
  console.log(`\n=== Venue ${venueId.slice(0, 8)} — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`)

  // Pull candidate interactions whose sender OR body references a
  // scheduling tool. Overmatches slightly; detectSchedulingEvent below
  // filters authoritatively.
  const { data: candidates } = await sb
    .from('interactions')
    .select('id, wedding_id, person_id, timestamp, subject, body_preview, full_body, from_email, from_name')
    .eq('venue_id', venueId)
    .or(
      'from_email.ilike.%calendly.com,from_email.ilike.%acuityscheduling.com,from_email.ilike.%honeybook.com,from_email.ilike.%dubsado.com,full_body.ilike.%calendly.com%,full_body.ilike.%acuityscheduling.com%'
    )
  const candidateCount = candidates?.length ?? 0
  console.log(`  candidate interactions: ${candidateCount}`)
  if (candidateCount === 0) return

  // Parse each — keep only ones where detectSchedulingEvent fires AND
  // we can resolve an invitee → wedding mapping.
  type Match = {
    interaction: InteractionRow
    event: SchedulingEvent
    weddingId: string
  }
  const matches: Match[] = []
  const unmatchedSamples: Array<{ reason: string; from: string; subject: string }> = []

  for (const c of (candidates ?? []) as InteractionRow[]) {
    const parsed = detectSchedulingEvent({
      from: c.from_email ?? '',
      subject: c.subject ?? '',
      body: c.full_body ?? c.body_preview ?? '',
    })
    if (!parsed) {
      unmatchedSamples.push({
        reason: 'no scheduling event pattern matched',
        from: c.from_email ?? '',
        subject: (c.subject ?? '').slice(0, 80),
      })
      continue
    }
    const wid = await findWeddingForInvitee(venueId, parsed.inviteeEmail)
    if (!wid) {
      unmatchedSamples.push({
        reason: `no wedding for invitee=${parsed.inviteeEmail}`,
        from: c.from_email ?? '',
        subject: (c.subject ?? '').slice(0, 80),
      })
      continue
    }
    matches.push({ interaction: c, event: parsed, weddingId: wid })
  }

  console.log(`  matched: ${matches.length}`)
  console.log(`  unmatched: ${candidateCount - matches.length}`)

  // Breakdown by source + kind
  const bySource: Record<string, Record<string, number>> = {}
  for (const m of matches) {
    if (!bySource[m.event.source]) bySource[m.event.source] = {}
    bySource[m.event.source][m.event.kind] = (bySource[m.event.source][m.event.kind] ?? 0) + 1
  }
  for (const [src, kinds] of Object.entries(bySource)) {
    console.log(`    ${src.padEnd(10)} ${JSON.stringify(kinds)}`)
  }

  if (unmatchedSamples.length > 0 && unmatchedSamples.length <= 10) {
    console.log('  unmatched samples:')
    for (const u of unmatchedSamples.slice(0, 10)) {
      console.log(`    from=${u.from.slice(0, 40).padEnd(40)} subject="${u.subject}" — ${u.reason}`)
    }
  }

  if (!APPLY) return

  // Dedup guard — load existing events keyed by (wedding_id, interaction_id)
  const weddingIds = Array.from(new Set(matches.map((m) => m.weddingId)))
  const { data: existing } = await sb
    .from('engagement_events')
    .select('wedding_id, event_type, metadata')
    .in('wedding_id', weddingIds)
  const seen = new Set<string>()
  for (const e of (existing ?? []) as any[]) {
    const iid = e.metadata?.interaction_id as string | undefined
    if (iid) seen.add(`${e.wedding_id}:${e.event_type}:${iid}`)
  }

  // Re-link interactions to the right wedding + fire events + advance status
  let relinked = 0
  let eventsFired = 0
  let statusAdvanced = 0
  const weddingsTouched = new Set<string>()

  for (const m of matches) {
    // Re-link interaction if it's on a different (or no) wedding
    if (m.interaction.wedding_id !== m.weddingId) {
      const { error } = await sb
        .from('interactions')
        .update({ wedding_id: m.weddingId })
        .eq('id', m.interaction.id)
      if (error) {
        console.error(`  relink ${m.interaction.id.slice(0, 8)}:`, error.message)
        continue
      }
      relinked++
    }

    // Fire engagement event if not already present
    const eventType = eventKindToEngagementType(m.event.kind)
    const dedupKey = `${m.weddingId}:${eventType}:${m.interaction.id}`
    if (!seen.has(dedupKey)) {
      try {
        await recordEngagementEventsBatch(venueId, m.weddingId, [{
          eventType,
          metadata: {
            interaction_id: m.interaction.id,
            source: m.event.source,
            scheduling_kind: m.event.kind,
            event_datetime: m.event.eventDatetime,
          },
          occurredAt: m.interaction.timestamp,
        }])
        eventsFired++
        seen.add(dedupKey)
      } catch (err) {
        console.error(`  event insert ${m.interaction.id.slice(0, 8)}:`, (err as Error).message)
        continue
      }
    }
    weddingsTouched.add(m.weddingId)

    // Status advance — apply only if it's actually a forward move
    const targetStatus = eventKindToStatus(m.event.kind)
    if (targetStatus) {
      const { data: w } = await sb.from('weddings').select('status').eq('id', m.weddingId).maybeSingle()
      const current = (w?.status as string | undefined) ?? 'inquiry'
      const currentRank = STATUS_RANK[current] ?? 0
      const targetRank = STATUS_RANK[targetStatus] ?? 0
      if (currentRank < 99 && targetRank > currentRank) {
        const { error } = await sb.from('weddings').update({ status: targetStatus }).eq('id', m.weddingId)
        if (!error) statusAdvanced++
      }
    }
  }

  // Recalc heat for every touched wedding
  for (const wid of weddingsTouched) {
    try {
      await recalculateHeatScore(venueId, wid)
    } catch (err) {
      console.error(`  recalc ${wid.slice(0, 8)}:`, (err as Error).message)
    }
  }

  console.log(`  relinked: ${relinked}`)
  console.log(`  events fired: ${eventsFired}`)
  console.log(`  status advanced: ${statusAdvanced}`)
  console.log(`  weddings touched: ${weddingsTouched.size}`)
}

async function main() {
  let venueIds: string[] = [CLI_VENUE ?? RIXEY]
  if (ALL) {
    const { data: vs } = await sb.from('venues').select('id, is_demo').eq('is_demo', false)
    venueIds = (vs ?? []).map((v: any) => v.id)
    console.log(`--all: backfilling scheduling events for ${venueIds.length} non-demo venue(s)`)
  }
  for (const vid of venueIds) {
    await runVenue(vid)
  }
}

main().catch((err) => {
  console.error('Backfill failed:', err)
  process.exit(1)
})
