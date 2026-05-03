/**
 * Stream SS — investigate why source_attribution shows 'other' as top
 * revenue source instead of 'honeybook' (migration 186 should have moved
 * those rows from 'other' → 'honeybook').
 */
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

let raw = ''
for (const c of ['.env.local', 'C:\\Users\\Ismar\\bloom-house\\.env.local']) {
  try { raw = readFileSync(c, 'utf8'); break } catch { /* try next */ }
}
const env = Object.fromEntries(
  raw
    .split('\n')
    .filter((l) => l && !l.startsWith('#') && l.includes('='))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')] })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })

async function main() {
  // Distribution of source for booked active weddings
  const { data: booked } = await sb
    .from('weddings').select('source, crm_source, booking_value, status')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
    .eq('status', 'booked')
  console.log(`Active booked weddings: ${booked?.length ?? 0}`)
  const bySrc = new Map<string, { count: number; rev: number }>()
  for (const w of (booked ?? []) as Array<{ source: string | null; crm_source: string | null; booking_value: number | null }>) {
    const k = w.source ?? '(null)'
    const e = bySrc.get(k) ?? { count: 0, rev: 0 }
    e.count += 1
    e.rev += (w.booking_value ?? 0) / 100
    bySrc.set(k, e)
  }
  console.log('Booked weddings by source:')
  for (const [k, v] of [...bySrc.entries()].sort((a, b) => b[1].rev - a[1].rev)) {
    console.log(`  ${k}: count=${v.count} revenue=$${v.rev.toFixed(2)}`)
  }

  // Specifically check 'other' bucket — what crm_source do they have?
  const { data: others } = await sb
    .from('weddings').select('id, source, crm_source, booking_value, source_detail, status')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
    .eq('source', 'other').limit(20)
  console.log(`\nSample 'source=other' rows (n=${others?.length ?? 0}):`)
  for (const w of (others ?? []) as Array<{ id: string; source: string | null; crm_source: string | null; booking_value: number | null; source_detail: string | null; status: string | null }>) {
    console.log(`  ${w.id.slice(0, 8)}  status=${w.status} bv=${w.booking_value} crm=${w.crm_source} detail=${w.source_detail}`)
  }

  // Total 'other' count
  const { count: otherCount } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).eq('source', 'other')
  console.log(`\nTotal 'source=other' active rows: ${otherCount}`)

  const { count: honeybookCount } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null).eq('source', 'honeybook')
  console.log(`Total 'source=honeybook' active rows: ${honeybookCount}`)

  const { count: othersWithHbCrm } = await sb
    .from('weddings').select('id', { count: 'exact', head: true })
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
    .eq('source', 'other').eq('crm_source', 'honeybook')
  console.log(`Active source='other' AND crm='honeybook' (should be 0 post-186): ${othersWithHbCrm}`)
}

main().catch((e) => { console.error(e); process.exit(1) })
