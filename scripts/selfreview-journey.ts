// Phase JT self-review: exercise getWeddingJourney across multiple
// Rixey weddings with different shapes (calendly-source, knot-source,
// merged, recently-onboarded, post-booking). Verify:
//   1. Events come back in chronological order.
//   2. No event reaches us twice via different tables (touchpoints +
//      engagement_events overlap is the obvious risk).
//   3. Cross-venue safety: querying with a wrong venueId returns [].
//   4. Touchpoint backtrace metadata surfaces in the description.
//   5. Each category that should appear actually does for at least
//      one wedding in the sample.
import { getWeddingJourney } from '../src/lib/services/wedding-journey'
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
for (const k of Object.keys(env)) if (!process.env[k]) process.env[k] = env[k]
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

async function pickSampleWeddings(): Promise<Array<{ id: string; label: string }>> {
  const out: Array<{ id: string; label: string }> = []

  // a) calendly-source booked
  const { data: cal } = await sb
    .from('weddings')
    .select('id, source')
    .eq('venue_id', RIXEY)
    .eq('source', 'calendly')
    .eq('status', 'booked')
    .limit(1)
  if (cal?.[0]) out.push({ id: cal[0].id as string, label: 'calendly-booked' })

  // b) the_knot-source (any status)
  const { data: knot } = await sb
    .from('weddings')
    .select('id, status')
    .eq('venue_id', RIXEY)
    .eq('source', 'the_knot')
    .order('inquiry_date', { ascending: false })
    .limit(1)
  if (knot?.[0]) out.push({ id: knot[0].id as string, label: 'knot-' + (knot[0].status as string) })

  // c) any wedding linked to a person_merges row
  const { data: mergeRow } = await sb
    .from('person_merges')
    .select('kept_person_id')
    .eq('venue_id', RIXEY)
    .not('kept_person_id', 'is', null)
    .limit(1)
  if (mergeRow?.[0]) {
    const { data: ppl } = await sb
      .from('people')
      .select('wedding_id')
      .eq('id', mergeRow[0].kept_person_id as string)
      .maybeSingle()
    if (ppl?.wedding_id) out.push({ id: ppl.wedding_id as string, label: 'merged' })
  }

  // d) the wedding with the most interactions (heaviest journey)
  const { data: ixCounts } = await sb
    .from('interactions')
    .select('wedding_id')
    .eq('venue_id', RIXEY)
    .not('wedding_id', 'is', null)
    .limit(2000)
  const ixByWedding = new Map<string, number>()
  for (const r of (ixCounts ?? []) as Array<{ wedding_id: string }>) {
    ixByWedding.set(r.wedding_id, (ixByWedding.get(r.wedding_id) ?? 0) + 1)
  }
  const heaviest = [...ixByWedding.entries()].sort((a, b) => b[1] - a[1])[0]
  if (heaviest) out.push({ id: heaviest[0], label: `heaviest-${heaviest[1]}-ix` })

  return out
}

async function summarize(events: Awaited<ReturnType<typeof getWeddingJourney>>) {
  const byCat: Record<string, number> = {}
  for (const e of events) byCat[e.category] = (byCat[e.category] ?? 0) + 1
  return byCat
}

async function checkOrdering(events: Awaited<ReturnType<typeof getWeddingJourney>>): Promise<string | null> {
  for (let i = 1; i < events.length; i++) {
    if (new Date(events[i].timestamp).getTime() < new Date(events[i - 1].timestamp).getTime()) {
      return `out-of-order at index ${i}: ${events[i - 1].timestamp} -> ${events[i].timestamp}`
    }
  }
  return null
}

async function checkDuplicates(events: Awaited<ReturnType<typeof getWeddingJourney>>): Promise<string[]> {
  const issues: string[] = []
  for (let i = 1; i < events.length; i++) {
    const a = events[i - 1]
    const b = events[i]
    const dt = Math.abs(new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
    if (dt < 60_000 && a.title === b.title && a.actor === b.actor) {
      issues.push(`possible dup at ${b.timestamp}: ${a.title}`)
    }
  }
  return issues
}

async function main() {
  console.log(`\n=== Wedding journey self-review (venue ${RIXEY.slice(0, 8)}) ===\n`)

  const samples = await pickSampleWeddings()
  console.log(`Picked ${samples.length} sample weddings:\n`)

  const allCategoriesSeen = new Set<string>()

  for (const s of samples) {
    console.log(`--- ${s.label} (${s.id.slice(0, 8)}) ---`)
    const events = await getWeddingJourney(RIXEY, s.id)
    console.log(`  total events: ${events.length}`)
    if (events.length === 0) {
      console.log(`  (empty journey)`)
      continue
    }
    const byCat = await summarize(events)
    console.log(`  by category: ${JSON.stringify(byCat)}`)
    Object.keys(byCat).forEach((c) => allCategoriesSeen.add(c))

    const orderingIssue = await checkOrdering(events)
    if (orderingIssue) console.log(`  ❌ ORDERING: ${orderingIssue}`)
    else console.log(`  ✓ ordering`)

    const dups = await checkDuplicates(events)
    if (dups.length > 0) {
      console.log(`  ⚠ ${dups.length} possible dup(s):`)
      for (const d of dups.slice(0, 3)) console.log(`     ${d}`)
    } else {
      console.log(`  ✓ no near-duplicates`)
    }

    // Show first 3 + last 3 for spot-check
    console.log(`  first 3:`)
    for (const e of events.slice(0, 3)) {
      console.log(`    ${e.timestamp.slice(0, 19)} [${e.category}] ${e.title}`)
    }
    if (events.length > 6) {
      console.log(`  …`)
      console.log(`  last 3:`)
      for (const e of events.slice(-3)) {
        console.log(`    ${e.timestamp.slice(0, 19)} [${e.category}] ${e.title}`)
      }
    }

    // Check: does any event mention a backtraced re-attribution?
    const reattributed = events.find((e) => e.description?.includes('re-attributed'))
    if (reattributed) {
      console.log(`  ✓ re-attribution surfaced: "${reattributed.description}"`)
    }
    console.log()
  }

  console.log(`Categories observed across samples: ${[...allCategoriesSeen].sort().join(', ')}`)

  // CHECK 3: cross-venue safety
  console.log(`\n--- cross-venue safety check ---`)
  const fakeVenue = '00000000-0000-0000-0000-000000000000'
  const sample = samples[0]
  if (sample) {
    const cross = await getWeddingJourney(fakeVenue, sample.id)
    console.log(`  venue=${fakeVenue.slice(0, 8)} wedding=${sample.id.slice(0, 8)} → ${cross.length} events (expect 0)`)
    if (cross.length === 0) console.log(`  ✓ blocked`)
    else console.log(`  ❌ LEAK`)
  }

  // CHECK 4: bogus weddingId
  console.log(`\n--- bogus weddingId check ---`)
  const ghost = await getWeddingJourney(RIXEY, '99999999-9999-9999-9999-999999999999')
  console.log(`  fake wedding → ${ghost.length} events (expect 0)`)
  if (ghost.length === 0) console.log(`  ✓ handled`)
  else console.log(`  ❌ LEAK`)

  console.log('\n=== done ===')
}

main().catch((err) => { console.error(err); process.exit(1) })
