/**
 * Wave 12 — exercise buildCoupleTimeline directly.
 *
 * Usage:
 *   node --env-file=.env.local node_modules/tsx/dist/cli.mjs scripts/test-wave12-build.ts
 */

import { createClient } from '@supabase/supabase-js'
import { buildCoupleTimeline } from '../src/lib/services/timeline/build-timeline'

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
)

async function main() {
  // Find Rixey
  const { data: venues } = await sb
    .from('venues')
    .select('id, name')
    .ilike('name', '%rixey%')
    .limit(2)
  const rixey = venues?.[0] as { id: string; name: string } | undefined
  if (!rixey) {
    console.log('No Rixey venue found.')
    return
  }

  // Pick a few candidate weddings
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, venue_id')
    .eq('venue_id', rixey.id)
    .is('merged_into_id', null)
    .limit(100)
  if (!weddings?.length) {
    console.log('No Rixey weddings.')
    return
  }

  let busiest: { id: string } | null = null
  let busiestCount = 0
  for (const w of weddings as Array<{ id: string }>) {
    const { count } = await sb
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', w.id)
    if ((count ?? 0) > busiestCount) {
      busiest = w
      busiestCount = count ?? 0
    }
  }
  if (!busiest) {
    console.log('No wedding with interactions.')
    return
  }
  console.log('Busiest Rixey wedding:', busiest.id, 'with', busiestCount, 'interactions')

  const result = await buildCoupleTimeline({
    weddingId: busiest.id,
    supabase: sb,
  })

  console.log('Total events:', result.events.length)
  console.log('truncated:', result.truncated)
  console.log('totalEvents (pre-cap):', result.totalEvents)
  console.log('scope:', result.scope)
  console.log('countsByKind:', result.countsByKind)

  // Print one example per kind
  const seen = new Set<string>()
  console.log('\nSample event per kind:')
  for (const e of result.events) {
    if (seen.has(e.kind)) continue
    seen.add(e.kind)
    console.log('  [' + e.kind + ']')
    console.log('    title:', e.title)
    console.log('    timestamp:', e.timestamp)
    console.log('    stage_at_time:', e.lifecycle_stage_at_time ?? '(null)')
    console.log('    actor:', e.actor)
    console.log('    payload_ref:', e.payload_ref)
  }

  // Sanity: timestamps are ASC
  let prev = -Infinity
  let asc = true
  for (const e of result.events) {
    const t = Date.parse(e.timestamp)
    if (Number.isFinite(t)) {
      if (t < prev) {
        asc = false
        break
      }
      prev = t
    }
  }
  console.log('\nASC order check:', asc ? 'OK' : 'FAILED')

  // Show first 5 and last 5 events
  console.log('\nFirst 3:')
  for (const e of result.events.slice(0, 3)) {
    console.log('  ', e.timestamp, '·', e.kind, '·', e.title.slice(0, 80))
  }
  console.log('Last 3:')
  for (const e of result.events.slice(-3)) {
    console.log('  ', e.timestamp, '·', e.kind, '·', e.title.slice(0, 80))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
