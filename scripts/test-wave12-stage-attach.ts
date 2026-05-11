/**
 * Wave 12 — verify lifecycle_stage_at_time computation by picking a
 * wedding with multiple lifecycle_transitions rows.
 */
import { createClient } from '@supabase/supabase-js'
import { buildCoupleTimeline } from '../src/lib/services/timeline/build-timeline'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

async function main() {
  // Find any wedding with the most lifecycle_transitions
  const { data } = await sb
    .from('lifecycle_transitions')
    .select('wedding_id')
    .limit(2000)
  if (!data?.length) {
    console.log('No lifecycle_transitions rows at all yet.')
    return
  }
  const counts = new Map<string, number>()
  for (const r of data as Array<{ wedding_id: string }>) {
    counts.set(r.wedding_id, (counts.get(r.wedding_id) ?? 0) + 1)
  }
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])
  const top = sorted[0]
  if (!top) return
  const [wid, n] = top
  console.log('Picked wedding', wid, 'with', n, 'lifecycle transitions')

  const result = await buildCoupleTimeline({ weddingId: wid, supabase: sb })
  console.log('Total events:', result.events.length)
  console.log('countsByKind:', result.countsByKind)

  // Show all lifecycle_transitions in order plus a few interactions
  // around them
  const lcEvents = result.events.filter((e) => e.kind === 'lifecycle_transition')
  console.log('\nLifecycle transitions:')
  for (const e of lcEvents) {
    console.log('  ', e.timestamp, '·', e.title, '· was-in:', e.lifecycle_stage_at_time)
  }

  // Print stage_at_time for first/last 5 events
  console.log('\nFirst 5 events with stage chip:')
  for (const e of result.events.slice(0, 5)) {
    console.log('  ', e.timestamp, '·', e.kind, '·', '[stage:', e.lifecycle_stage_at_time ?? 'null', ']', e.title.slice(0, 60))
  }
  console.log('\nLast 5 events with stage chip:')
  for (const e of result.events.slice(-5)) {
    console.log('  ', e.timestamp, '·', e.kind, '·', '[stage:', e.lifecycle_stage_at_time ?? 'null', ']', e.title.slice(0, 60))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
