import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
    }),
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
})
const venueId = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// For each intent_class, count weddings + booked weddings
const { data: aes } = await sb
  .from('attribution_events')
  .select('intent_class, wedding_id')
  .eq('venue_id', venueId)
  .ilike('source_platform', '%knot%')
  .is('reverted_at', null)
  .not('wedding_id', 'is', null)

const byIntent = { targeted: new Set(), broadcast: new Set(), unknown: new Set() }
for (const r of aes ?? []) {
  if (r.wedding_id && byIntent[r.intent_class]) byIntent[r.intent_class].add(r.wedding_id)
}
for (const k of Object.keys(byIntent)) {
  const ids = [...byIntent[k]]
  if (ids.length === 0) continue
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, status, booked_at, lost_at, tour_date')
    .in('id', ids.slice(0, 500))
  const byStatus = {}
  let bookedCount = 0
  let tourCount = 0
  for (const w of weddings ?? []) {
    byStatus[w.status] = (byStatus[w.status] || 0) + 1
    if (w.status === 'booked' || w.booked_at) bookedCount++
    if (w.tour_date) tourCount++
  }
  console.log(`\n${k}: ${ids.length} weddings`)
  console.log('  byStatus:', byStatus)
  console.log(`  booked: ${bookedCount} (${((bookedCount/ids.length)*100).toFixed(1)}%)`)
  console.log(`  tour scheduled: ${tourCount} (${((tourCount/ids.length)*100).toFixed(1)}%)`)
}
