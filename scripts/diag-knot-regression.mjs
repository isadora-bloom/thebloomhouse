import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n')
    .filter(l => l && !l.startsWith('#') && l.includes('=')).map(l => {
      const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

// Knot interactions since April 2026 — are they linked to weddings?
const { data: knotRecentAll } = await sb.from('interactions')
  .select('id, subject, timestamp, from_email, wedding_id, direction')
  .eq('venue_id', RIXEY)
  .ilike('from_email', '%theknot%')
  .gte('timestamp', '2026-04-01')
  .order('timestamp', { ascending: true })

const linked = (knotRecentAll ?? []).filter(r => r.wedding_id)
const orphan = (knotRecentAll ?? []).filter(r => !r.wedding_id)

console.log(`=== KNOT INTERACTIONS SINCE APR 2026 ===`)
console.log(`Total: ${knotRecentAll?.length}, linked: ${linked.length}, orphan (no wedding_id): ${orphan.length}`)

if (orphan.length) {
  console.log('\nOrphan Knot interactions (no wedding):')
  for (const r of orphan) {
    console.log(`  ${r.timestamp?.slice(0,10)}  ${r.direction?.padEnd(8)}  ${r.from_email?.split('@')[0].padEnd(30)}  ${r.subject?.slice(0,50)}`)
  }
}

// Knot interactions before April 2026 — baseline comparison
const months = ['2025-10','2025-11','2025-12','2026-01','2026-02','2026-03','2026-04','2026-05','2026-06']
console.log('\n=== KNOT BY MONTH (total / linked / orphan) ===')
for (const m of months) {
  const [yr, mo] = m.split('-')
  const nextMo = String(parseInt(mo)+1).padStart(2,'0')
  const nextYr = parseInt(mo) === 12 ? String(parseInt(yr)+1) : yr
  const next = parseInt(mo) === 12 ? `${nextYr}-01` : `${yr}-${nextMo}`
  const { data } = await sb.from('interactions')
    .select('id, wedding_id')
    .eq('venue_id', RIXEY)
    .ilike('from_email', '%theknot%')
    .gte('timestamp', `${m}-01`)
    .lt('timestamp', `${next}-01`)
  const tot = data?.length ?? 0
  const lnk = data?.filter(r => r.wedding_id).length ?? 0
  console.log(`  ${m}: ${String(tot).padStart(3)} total, ${String(lnk).padStart(3)} linked, ${String(tot-lnk).padStart(3)} orphan`)
}

// Check if new Knot emails exist in Gmail but aren't in interactions (requires checking for very recent missing ones)
// Best proxy: look at couples created via Knot in recent months
const { data: knotWeddings } = await sb.from('weddings')
  .select('id, created_at, lead_source, status, inquiry_date')
  .eq('venue_id', RIXEY)
  .eq('lead_source', 'the_knot')
  .gte('created_at', '2026-04-01')
  .order('created_at', { ascending: true })

console.log(`\n=== WEDDINGS WITH lead_source=the_knot since APR 2026 ===`)
console.log(`Count: ${knotWeddings?.length ?? 0}`)
for (const w of knotWeddings ?? []) {
  console.log(`  ${w.created_at?.slice(0,10)}  status=${w.status?.padEnd(10)}  inquiry=${w.inquiry_date?.slice(0,10)}`)
}
