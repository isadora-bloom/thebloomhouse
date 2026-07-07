// One-off: why are Knot leads down while bookings + calculator submissions are up?
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l && !l.startsWith('#') && l.includes('=')).map((l) => {
    const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^['"]|['"]$/g, '')]
  })
)
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
const RIXEY = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

const ym = (d: string | null) => (d ? String(d).slice(0, 7) : '(no-date)')
const pad = (s: string, n: number) => s.padEnd(n)
function table(title: string, months: string[], cats: string[], grid: Map<string, Map<string, number>>) {
  console.log(`\n=== ${title} ===`)
  console.log(pad('month', 9) + cats.map((s) => pad(s.slice(0, 13), 14)).join('') + 'TOTAL')
  for (const m of months) {
    const mm = grid.get(m) ?? new Map()
    let tot = 0; for (const v of mm.values()) tot += v
    console.log(pad(m, 9) + cats.map((s) => pad(String(mm.get(s) ?? 0), 14)).join('') + String(tot))
  }
}
function add(grid: Map<string, Map<string, number>>, m: string, k: string) {
  if (!grid.has(m)) grid.set(m, new Map())
  const mm = grid.get(m)!; mm.set(k, (mm.get(k) ?? 0) + 1)
}

async function main() {
  const { data: wedd } = await sb
    .from('weddings')
    .select('id, source, source_kind, source_detail, lead_source, status, created_at, inquiry_date, booked_at')
    .eq('venue_id', RIXEY)
  const rows = (wedd ?? []) as Array<Record<string, any>>
  console.log(`WEDDINGS rows: ${rows.length}`)

  const srcCounts = new Map<string, number>()
  for (const r of rows) srcCounts.set(r.source ?? '(null)', (srcCounts.get(r.source ?? '(null)') ?? 0) + 1)
  console.log('\nDistinct weddings.source (all-time):')
  for (const [s, c] of [...srcCounts].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(s, 24)} ${c}`)

  const inqDate = (r: Record<string, any>) => r.inquiry_date ?? r.created_at
  const topSources = [...srcCounts].sort((a, b) => b[1] - a[1]).slice(0, 7).map((x) => x[0])

  // New leads per month x source
  const leadGrid = new Map<string, Map<string, number>>()
  const monthsSet = new Set<string>()
  for (const r of rows) { const m = ym(inqDate(r)); monthsSet.add(m); add(leadGrid, m, r.source ?? '(null)') }
  const months = [...monthsSet].filter((m) => m >= '2025-09' && m !== '(no-date)').sort()
  table('NEW LEADS / month by source (inquiry_date)', months, topSources, leadGrid)

  // Bookings per month x source
  const bookGrid = new Map<string, Map<string, number>>()
  const bMonthsSet = new Set<string>()
  for (const r of rows) {
    if (!['booked', 'completed'].includes(r.status)) continue
    const m = ym(r.booked_at ?? inqDate(r)); bMonthsSet.add(m); add(bookGrid, m, r.source ?? '(null)')
  }
  const bMonths = [...bMonthsSet].filter((m) => m >= '2025-09' && m !== '(no-date)').sort()
  table('BOOKINGS / month by source (booked_at)', bMonths, topSources, bookGrid)

  // Interactions: inbound type mix + Knot detection via from_email (PAGINATED — PostgREST caps at 1000/req)
  const irows: Array<Record<string, any>> = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('interactions')
      .select('type, direction, from_email, subject, timestamp, created_at')
      .eq('venue_id', RIXEY)
      .gte('created_at', '2025-09-01')
      .order('created_at', { ascending: true })
      .range(from, from + 999)
    if (error) { console.error('inter err', error.message); break }
    if (!data || data.length === 0) break
    irows.push(...data)
    if (data.length < 1000) break
  }
  console.log(`\nINTERACTIONS rows since 2025-09: ${irows.length}`)

  const typeGrid = new Map<string, Map<string, number>>()
  const knotGrid = new Map<string, Map<string, number>>() // knot vs other inbound email
  const tMonthsSet = new Set<string>()
  const typeCounts = new Map<string, number>()
  for (const r of irows) {
    if (r.direction && r.direction !== 'inbound') continue
    const m = ym(r.timestamp ?? r.created_at); tMonthsSet.add(m)
    const t = r.type ?? '(null)'
    typeCounts.set(t, (typeCounts.get(t) ?? 0) + 1)
    add(typeGrid, m, t)
    const fe = String(r.from_email ?? '').toLowerCase()
    if (fe.includes('theknot.com')) add(knotGrid, m, 'theKnot')
    else if (fe.includes('zola.com')) add(knotGrid, m, 'Zola')
    else if (fe.includes('weddingwire')) add(knotGrid, m, 'WeddingWire')
    else if (fe.includes('honeybook')) add(knotGrid, m, 'HoneyBook')
    else if (t === 'email') add(knotGrid, m, 'direct/other email')
  }
  const topT = [...typeCounts].sort((a, b) => b[1] - a[1]).slice(0, 7).map((x) => x[0])
  const tMonths = [...tMonthsSet].filter((m) => m >= '2025-09' && m !== '(no-date)').sort()
  table('INBOUND INTERACTIONS / month by type', tMonths, topT, typeGrid)
  table('INBOUND EMAIL / month by marketplace (from_email domain)', tMonths,
    ['theKnot', 'Zola', 'WeddingWire', 'HoneyBook', 'direct/other email'], knotGrid)
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
