/**
 * Stream SS — deeper dive on revenue source attribution.
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'
let raw = ''
for (const c of ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']) {
  try { raw = readFileSync(c, 'utf8'); break } catch { /* */ }
}
const env = Object.fromEntries(
  raw.split('\n').filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  // ALL active weddings (not just booked)
  const { data: all } = await sb
    .from('weddings').select('source, status, booking_value')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  console.log(`Total active: ${all?.length ?? 0}`)

  const bySrc = new Map<string, { count: number; rev: number; booked: number }>()
  for (const w of (all ?? []) as Array<{ source: string | null; status: string | null; booking_value: number | null }>) {
    const k = w.source ?? '(null)'
    const e = bySrc.get(k) ?? { count: 0, rev: 0, booked: 0 }
    e.count += 1
    if (w.status === 'booked') {
      e.booked += 1
      e.rev += (w.booking_value ?? 0) / 100
    }
    bySrc.set(k, e)
  }
  console.log('\nAll active weddings by source (count / booked / revenue):')
  for (const [k, v] of [...bySrc.entries()].sort((a, b) => b[1].rev - a[1].rev)) {
    console.log(`  ${k}: count=${v.count} booked=${v.booked} rev=$${v.rev.toFixed(2)}`)
  }

  // Check including merged-out
  const { data: allWithMerged } = await sb
    .from('weddings').select('source, status, booking_value, merged_into_id')
    .eq('venue_id', RIXEY_ID)
  let mergedHB = 0
  let mergedHBRev = 0
  for (const w of (allWithMerged ?? []) as Array<{ source: string | null; status: string | null; booking_value: number | null; merged_into_id: string | null }>) {
    if (w.merged_into_id && w.source === 'honeybook') {
      mergedHB++
      if (w.status === 'booked') mergedHBRev += (w.booking_value ?? 0) / 100
    }
  }
  console.log(`\nMerged-out HoneyBook rows: ${mergedHB} (booked rev: $${mergedHBRev.toFixed(2)})`)

  // Source_attribution table contents
  const { data: srcAttr } = await sb
    .from('source_attribution').select('source, revenue, period_start, bookings, inquiries')
    .eq('venue_id', RIXEY_ID).order('period_start')
  console.log(`\nsource_attribution rows: ${srcAttr?.length ?? 0}`)
  for (const r of (srcAttr ?? []) as Array<{ source: string; revenue: number; period_start: string; bookings: number; inquiries: number }>) {
    if (Number(r.revenue || 0) > 0 || r.bookings > 0 || r.inquiries > 5) {
      console.log(`  ${r.period_start.slice(0, 4)}  ${r.source.padEnd(20)}  inq=${r.inquiries}  bk=${r.bookings}  rev=$${Number(r.revenue || 0).toFixed(2)}`)
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
