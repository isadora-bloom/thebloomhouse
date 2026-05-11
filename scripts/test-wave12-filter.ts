/**
 * Wave 12 — exercise kinds filter and since/until bounds.
 */
import { createClient } from '@supabase/supabase-js'
import { buildCoupleTimeline } from '../src/lib/services/timeline/build-timeline'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

async function main() {
  // Use the wedding from the previous test (Emma Heller — has all 4 kinds).
  const wid = 'ef2798ab-6e0f-40ac-acf9-45f47bb0f4f8'

  console.log('--- kinds=[interaction] ---')
  const r1 = await buildCoupleTimeline({
    weddingId: wid,
    supabase: sb,
    kinds: ['interaction'],
  })
  console.log('events:', r1.events.length, 'countsByKind:', r1.countsByKind)

  console.log('\n--- kinds=[lifecycle_transition, attribution_event] ---')
  const r2 = await buildCoupleTimeline({
    weddingId: wid,
    supabase: sb,
    kinds: ['lifecycle_transition', 'attribution_event'],
  })
  console.log('events:', r2.events.length, 'countsByKind:', r2.countsByKind)
  for (const e of r2.events) console.log('  ', e.timestamp, '·', e.kind, '·', e.title.slice(0, 60))

  console.log('\n--- since=2026-05-01 ---')
  const r3 = await buildCoupleTimeline({
    weddingId: wid,
    supabase: sb,
    since: '2026-05-01T00:00:00Z',
  })
  console.log('events:', r3.events.length, 'countsByKind:', r3.countsByKind)

  console.log('\n--- maxEvents=2 (truncation) ---')
  const r4 = await buildCoupleTimeline({
    weddingId: wid,
    supabase: sb,
    maxEvents: 2,
  })
  console.log('events:', r4.events.length, 'truncated:', r4.truncated, 'totalEvents:', r4.totalEvents)
  for (const e of r4.events) console.log('  ', e.timestamp, '·', e.kind)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
