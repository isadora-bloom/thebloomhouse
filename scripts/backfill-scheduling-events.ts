// Post-hoc cleanup: walk every interaction whose body is a Calendly /
// Acuity / HoneyBook / Dubsado notification and repair:
//   1. Re-link orphaned interactions (wedding_id=null) by finding the
//      invitee's person → wedding. Create a wedding if the invitee has
//      no existing one (Calendly booking IS the new-wedding signal).
//   2. Fire tour_scheduled / contract_sent / etc. events that the
//      original ingest pipeline missed (before the
//      scheduling-tool parser landed).
//   3. Update person names when the Calendly Invitee label provides a
//      cleaner full name than the existing salvage-from-email ("Taylorm
//      Smith" → "Taylor Smith"; "Juliabrosenberger" → "Julia ...").
//   4. Seed partner2 from Calendly extras.partnerName/partnerEmail when
//      missing — most Calendly booking forms capture the second partner.
//
// Detection now works against stored interactions even though
// from_email was rewritten to the invitee at ingest time — the parser
// recognises Calendly by body signature + sender domain.
//
// Idempotent: dedupes engagement events by (wedding_id, event_type,
// interaction_id) metadata. Re-running is safe.
//
// Usage:
//   npx tsx scripts/backfill-scheduling-events.ts                # dry-run Rixey
//   npx tsx scripts/backfill-scheduling-events.ts --apply        # execute Rixey
//   npx tsx scripts/backfill-scheduling-events.ts --apply --all  # every real venue
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import {
  detectSchedulingEvent,
  eventKindToEngagementType,
  eventKindToStatus,
  timeAwareTourKind,
  type SchedulingEvent,
} from '../src/lib/services/scheduling-tool-parsers'
import { recordEngagementEventsBatch, recalculateHeatScore } from '../src/lib/services/heat-mapping'
import { resolveIdentity } from '../src/lib/services/identity-resolution'

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

const POSITIVE_KINDS = new Set([
  'tour_scheduled',
  'contract_sent', 'contract_signed', 'payment_received',
  'final_walkthrough', 'pre_wedding_event', 'planning_meeting',
])

async function findPerson(venueId: string, email: string): Promise<string | null> {
  const { data } = await sb
    .from('people')
    .select('id')
    .eq('venue_id', venueId)
    .ilike('email', email)
    .limit(1)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

async function findWeddingForPerson(venueId: string, personId: string): Promise<string | null> {
  const { data: a } = await sb
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .or(`primary_person_id.eq.${personId},partner1_person_id.eq.${personId},partner2_person_id.eq.${personId}`)
    .order('inquiry_date', { ascending: false })
    .limit(1)
  if (a && a.length > 0) return a[0].id as string

  const { data: b } = await sb.from('people').select('wedding_id').eq('id', personId).maybeSingle()
  if ((b as any)?.wedding_id) return (b as any).wedding_id as string

  const { data: c } = await sb
    .from('interactions')
    .select('wedding_id')
    .eq('venue_id', venueId)
    .eq('person_id', personId)
    .not('wedding_id', 'is', null)
    .limit(1)
  if (c && c.length > 0) return (c[0].wedding_id as string | null) ?? null
  return null
}

async function createWeddingForInvitee(
  venueId: string,
  event: SchedulingEvent,
  inquiryDate: string
): Promise<string | null> {
  const targetStatus = eventKindToStatus(event.kind) ?? 'tour_scheduled'
  const { data, error } = await sb
    .from('weddings')
    .insert({
      venue_id: venueId,
      status: targetStatus,
      source: event.source,
      inquiry_date: inquiryDate,
      heat_score: 0,
      temperature_tier: 'cool',
    })
    .select('id')
    .single()
  if (error) {
    console.error(`    wedding create failed: ${error.message}`)
    return null
  }
  return data?.id as string | null
}

async function ensurePerson(
  venueId: string,
  email: string,
  name: string | null,
  weddingId: string
): Promise<string | null> {
  const existing = await findPerson(venueId, email)
  if (existing) {
    // Update name if Calendly has a clean one and current is salvage-looking
    if (name) {
      const parts = name.trim().split(/\s+/)
      const first = parts[0]
      const last = parts.slice(1).join(' ') || null
      const { data: cur } = await sb
        .from('people')
        .select('first_name, last_name, wedding_id')
        .eq('id', existing)
        .maybeSingle()
      const curFirst = (cur?.first_name as string | null) ?? ''
      const curLast = (cur?.last_name as string | null) ?? ''
      // Overwrite salvage: single-token names, smushed no-space lowercase
      // that got capitalized ("Juliabrosenberger"), or anything missing a
      // last name. Never overwrite a two-token human-looking name.
      const hasSpace = (curFirst + ' ' + curLast).trim().split(/\s+/).length >= 2
      const isSmush = /^[A-Z][a-z]{6,}$/.test(curFirst) && !curLast
      const shouldReplace = !hasSpace || isSmush
      if (shouldReplace) {
        await sb.from('people').update({ first_name: first, last_name: last, wedding_id: weddingId }).eq('id', existing)
      } else if (!(cur as any)?.wedding_id) {
        await sb.from('people').update({ wedding_id: weddingId }).eq('id', existing)
      }
    }
    return existing
  }
  const parts = (name ?? email.split('@')[0]).trim().split(/\s+/)
  const first = parts[0] || null
  const last = parts.slice(1).join(' ') || null
  const { data, error } = await sb
    .from('people')
    .insert({
      venue_id: venueId,
      wedding_id: weddingId,
      role: 'partner1',
      first_name: first,
      last_name: last,
      email,
    })
    .select('id')
    .single()
  if (error) {
    console.error(`    person create failed: ${error.message}`)
    return null
  }
  return data?.id as string | null
}

async function ensurePartner2(
  venueId: string,
  weddingId: string,
  name: string,
  email: string | null,
  phone: string | null
) {
  // Skip if partner2 exists on this wedding
  const { data } = await sb
    .from('people')
    .select('id')
    .eq('wedding_id', weddingId)
    .eq('role', 'partner2')
    .limit(1)
  if (data && data.length > 0) return
  const parts = name.trim().split(/\s+/)
  const first = parts[0] || null
  const last = parts.slice(1).join(' ') || null
  await sb.from('people').insert({
    venue_id: venueId,
    wedding_id: weddingId,
    role: 'partner2',
    first_name: first,
    last_name: last,
    email,
    phone,
  })
}

async function runVenue(venueId: string) {
  console.log(`\n=== Venue ${venueId.slice(0, 8)} — ${APPLY ? 'APPLY' : 'DRY RUN'} ===`)

  // Pull every interaction whose body is a scheduling-tool notification.
  // Body signature match is authoritative; detectSchedulingEvent filters.
  const { data: candidates } = await sb
    .from('interactions')
    .select('id, wedding_id, person_id, timestamp, subject, body_preview, full_body, from_email, from_name')
    .eq('venue_id', venueId)
    .or(
      'full_body.ilike.%Invitee Email%,full_body.ilike.%A new event has been scheduled%,full_body.ilike.%your scheduled event%,subject.ilike.New Event:%,subject.ilike.Canceled:%,subject.ilike.Updated:%'
    )
  const total = candidates?.length ?? 0
  console.log(`  candidate interactions: ${total}`)
  if (total === 0) return

  type Plan =
    | { kind: 'reuse'; interactionId: string; weddingId: string; event: SchedulingEvent; timestamp: string; createdPerson?: boolean }
    | { kind: 'create_wedding'; interactionId: string; event: SchedulingEvent; timestamp: string }
    | { kind: 'skip'; interactionId: string; reason: string }

  const plans: Plan[] = []
  let parseFail = 0

  for (const c of (candidates ?? []) as any[]) {
    let event = detectSchedulingEvent({
      from: c.from_email ?? '',
      subject: c.subject ?? '',
      body: c.full_body ?? c.body_preview ?? '',
    })
    if (!event) {
      parseFail++
      plans.push({ kind: 'skip', interactionId: c.id, reason: 'parser returned null' })
      continue
    }
    // Time-aware: tour booked but its date has already passed = completed
    const adjusted = timeAwareTourKind(event.kind, event.eventDatetime)
    if (adjusted !== event.kind) event = { ...event, kind: adjusted }

    // Strategy 1: direct email match (invitee email ⇒ existing person ⇒ wedding)
    let resolvedWid: string | null = null
    const personByEmail = await findPerson(venueId, event.inviteeEmail)
    if (personByEmail) {
      resolvedWid = await findWeddingForPerson(venueId, personByEmail)
    }

    // Strategy 2: identity resolution with rich signals (phone + partner
    // + name). Catches couples who inquired via Knot/WeddingWire with
    // one email and booked Calendly with another.
    if (!resolvedWid) {
      const extras = event.extras
      const partnerParts = (extras?.partnerName ?? '').trim().split(/\s+/)
      const inviteeParts = (event.inviteeName ?? '').trim().split(/\s+/)
      try {
        const matches = await resolveIdentity(sb as any, {
          venueId,
          email: event.inviteeEmail,
          firstName: inviteeParts[0] || null,
          lastName: inviteeParts.slice(1).join(' ') || null,
          phone: extras?.phone ?? null,
          partnerFirstName: partnerParts[0] || null,
          partnerLastName: partnerParts.slice(1).join(' ') || null,
          signalDate: c.timestamp,
          excludePersonId: personByEmail ?? null,
        })
        // Historical backfill accepts medium-tier matches too. The
        // full_name_within_window signal ("same first + same last
        // within 30 days") typically catches the Knot-relay →
        // Calendly-invitee multi-touch journey: same couple, different
        // emails. Coordinators can unmerge later if wrong. Live path
        // stays on high-tier only (email-pipeline.ts).
        const best = matches.find((m) => m.tier === 'high')
          ?? matches.find((m) => m.tier === 'medium' && m.signals.some((s) => s.type === 'full_name_within_window'))
        if (best) {
          resolvedWid = await findWeddingForPerson(venueId, best.personId)
        }
      } catch (err) {
        // identity resolution is best-effort; fall through to create-new
        console.error(`  identity resolve error:`, (err as Error).message)
      }
    }

    if (resolvedWid) {
      plans.push({ kind: 'reuse', interactionId: c.id, weddingId: resolvedWid, event, timestamp: c.timestamp })
    } else if (POSITIVE_KINDS.has(event.kind)) {
      plans.push({ kind: 'create_wedding', interactionId: c.id, event, timestamp: c.timestamp })
    } else {
      plans.push({ kind: 'skip', interactionId: c.id, reason: `no wedding and kind=${event.kind}` })
    }
  }

  const reuse = plans.filter((p): p is Extract<Plan, { kind: 'reuse' }> => p.kind === 'reuse')
  const creates = plans.filter((p): p is Extract<Plan, { kind: 'create_wedding' }> => p.kind === 'create_wedding')
  const skips = plans.filter((p): p is Extract<Plan, { kind: 'skip' }> => p.kind === 'skip')
  console.log(`  parse-fail: ${parseFail}`)
  console.log(`  reuse existing wedding: ${reuse.length}`)
  console.log(`  create new wedding:     ${creates.length}`)
  console.log(`  skip:                   ${skips.length}`)

  const byKind: Record<string, number> = {}
  for (const p of [...reuse, ...creates]) byKind[p.event.kind] = (byKind[p.event.kind] ?? 0) + 1
  console.log(`  kind distribution:      ${JSON.stringify(byKind)}`)

  if (!APPLY) return

  // Execute plans
  const weddingsTouched = new Set<string>()

  // 1. Create new weddings first — then we can link their invitees
  for (const p of creates) {
    const wid = await createWeddingForInvitee(venueId, p.event, p.timestamp)
    if (!wid) continue
    // Ensure person → attach name from Calendly + link to wedding
    await ensurePerson(venueId, p.event.inviteeEmail, p.event.inviteeName, wid)
    // Link interaction
    await sb.from('interactions').update({ wedding_id: wid }).eq('id', p.interactionId)
    // Partner2 from extras
    if (p.event.extras?.partnerName) {
      await ensurePartner2(
        venueId,
        wid,
        p.event.extras.partnerName,
        p.event.extras.partnerEmail ?? null,
        p.event.extras.phone ?? null
      )
    }
    // Fire initial_inquiry to give the wedding baseline heat parity with
    // couples who entered via email
    await recordEngagementEventsBatch(
      venueId, wid,
      [{ eventType: 'initial_inquiry', metadata: { source: p.event.source, via: 'scheduling_tool_backfill' } }],
      p.timestamp
    )
    // Fire the scheduling event itself
    await recordEngagementEventsBatch(
      venueId, wid,
      [{
        eventType: eventKindToEngagementType(p.event.kind),
        metadata: {
          interaction_id: p.interactionId,
          source: p.event.source,
          scheduling_kind: p.event.kind,
          event_datetime: p.event.eventDatetime,
        },
      }],
      p.timestamp
    )
    weddingsTouched.add(wid)
  }

  // 2. Reuse existing weddings — link + fire event + (maybe) update status
  for (const p of reuse) {
    // Re-link interaction
    await sb.from('interactions').update({ wedding_id: p.weddingId }).eq('id', p.interactionId)
    // Update invitee's name if salvage-looking
    const personId = await findPerson(venueId, p.event.inviteeEmail)
    if (personId && p.event.inviteeName) {
      await ensurePerson(venueId, p.event.inviteeEmail, p.event.inviteeName, p.weddingId)
    }
    // Partner2 from extras
    if (p.event.extras?.partnerName) {
      await ensurePartner2(
        venueId,
        p.weddingId,
        p.event.extras.partnerName,
        p.event.extras.partnerEmail ?? null,
        p.event.extras.phone ?? null
      )
    }
    // Fire the scheduling event (dedup via metadata handled in recordEngagementEventsBatch? No —
    // we need to check ourselves before firing).
    const { data: existing } = await sb
      .from('engagement_events')
      .select('id')
      .eq('wedding_id', p.weddingId)
      .eq('event_type', eventKindToEngagementType(p.event.kind))
      .filter('metadata->>interaction_id', 'eq', p.interactionId)
      .limit(1)
    if (!existing || existing.length === 0) {
      await recordEngagementEventsBatch(
        venueId, p.weddingId,
        [{
          eventType: eventKindToEngagementType(p.event.kind),
          metadata: {
            interaction_id: p.interactionId,
            source: p.event.source,
            scheduling_kind: p.event.kind,
            event_datetime: p.event.eventDatetime,
          },
        }],
        p.timestamp
      )
    }
    // Status advance if this event warrants it
    const targetStatus = eventKindToStatus(p.event.kind)
    if (targetStatus) {
      const { data: w } = await sb.from('weddings').select('status').eq('id', p.weddingId).maybeSingle()
      const curRank = STATUS_RANK[(w?.status as string) ?? 'inquiry'] ?? 0
      const tgtRank = STATUS_RANK[targetStatus] ?? 0
      if (curRank < 99 && tgtRank > curRank) {
        await sb.from('weddings').update({ status: targetStatus }).eq('id', p.weddingId)
      }
    }
    weddingsTouched.add(p.weddingId)
  }

  // Recalc every touched wedding
  for (const wid of weddingsTouched) {
    try { await recalculateHeatScore(venueId, wid) } catch (err) {
      console.error(`  recalc ${wid.slice(0, 8)}:`, (err as Error).message)
    }
  }
  console.log(`  weddings touched: ${weddingsTouched.size}`)
}

async function main() {
  let venueIds: string[] = [CLI_VENUE ?? RIXEY]
  if (ALL) {
    const { data: vs } = await sb.from('venues').select('id, is_demo').eq('is_demo', false)
    venueIds = (vs ?? []).map((v: any) => v.id)
  }
  for (const vid of venueIds) {
    await runVenue(vid)
  }
}

main().catch((err) => { console.error('Backfill failed:', err); process.exit(1) })
