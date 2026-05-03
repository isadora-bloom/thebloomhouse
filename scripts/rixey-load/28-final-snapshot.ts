// Stream QQ: final post-state snapshot for the report.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

async function main() {
  const env = Object.fromEntries(
    readFileSync('.env.local', 'utf8').split('\n')
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
  )
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } })
  const RIXEY_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

  // source_attribution rollup by year
  console.log('=== source_attribution by year ===')
  const { data: sa } = await sb
    .from('source_attribution')
    .select('source, period_start, spend, inquiries, bookings, revenue')
    .eq('venue_id', RIXEY_ID)
    .order('period_start', { ascending: true })
  const yearTot: Record<string, { rows: number; spend: number; inq: number; book: number; rev: number }> = {}
  for (const r of sa ?? []) {
    const y = String(r.period_start).slice(0, 4)
    if (!yearTot[y]) yearTot[y] = { rows: 0, spend: 0, inq: 0, book: 0, rev: 0 }
    yearTot[y].rows++
    yearTot[y].spend += Number(r.spend) || 0
    yearTot[y].inq += Number(r.inquiries) || 0
    yearTot[y].book += Number(r.bookings) || 0
    yearTot[y].rev += Number(r.revenue) || 0
  }
  console.log('year | rows | spend $   | inquiries | bookings | revenue $')
  for (const [y, t] of Object.entries(yearTot).sort()) {
    console.log(`${y} | ${String(t.rows).padStart(4)} | ${String(Math.round(t.spend)).padStart(9)} | ${String(t.inq).padStart(9)} | ${String(t.book).padStart(8)} | ${String(Math.round(t.rev)).padStart(9)}`)
  }

  // top 5 source rows by revenue
  console.log('\nTop revenue rows in source_attribution:')
  for (const r of (sa ?? []).slice().sort((a, b) => (Number(b.revenue) || 0) - (Number(a.revenue) || 0)).slice(0, 5)) {
    console.log(`  ${String(r.period_start).slice(0,4)}  ${(r.source as string).padEnd(22)} rev=$${Math.round(Number(r.revenue) || 0).toLocaleString()}  book=${r.bookings}  inq=${r.inquiries}`)
  }

  // intelligence_insights summary
  const { data: ii } = await sb
    .from('intelligence_insights')
    .select('insight_type, status')
    .eq('venue_id', RIXEY_ID)
  const stats: Record<string, number> = {}
  for (const r of ii ?? []) {
    stats[`${r.insight_type}/${r.status}`] = (stats[`${r.insight_type}/${r.status}`] ?? 0) + 1
  }
  console.log('\nintelligence_insights breakdown:')
  for (const [k, v] of Object.entries(stats).sort()) console.log(`  ${k.padEnd(30)} ${v}`)

  // weddings.lead_source distribution
  const { data: leads } = await sb
    .from('weddings').select('lead_source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  const tally: Record<string, number> = {}
  for (const w of leads ?? []) tally[w.lead_source ?? '(null)'] = (tally[w.lead_source ?? '(null)'] ?? 0) + 1
  console.log('\nlead_source distribution (active):')
  for (const [k, v] of Object.entries(tally).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${v}`)
  }

  // weddings.source distribution
  const { data: srcs } = await sb
    .from('weddings').select('source')
    .eq('venue_id', RIXEY_ID).is('merged_into_id', null)
  const tally2: Record<string, number> = {}
  for (const w of srcs ?? []) tally2[w.source ?? '(null)'] = (tally2[w.source ?? '(null)'] ?? 0) + 1
  console.log('\nsource distribution (active):')
  for (const [k, v] of Object.entries(tally2).sort((a,b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${v}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
