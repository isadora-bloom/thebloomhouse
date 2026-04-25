// Snapshot what /intel/sources currently shows vs what touchpoint-driven
// attribution would show. Phase 2 audit step.
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

async function main() {
  console.log('\n=== source_attribution table (cron-computed) ===')
  const { data: attr } = await sb
    .from('source_attribution')
    .select('source, inquiries, tours, bookings, revenue, spend')
    .eq('venue_id', RIXEY)
    .order('inquiries', { ascending: false })
  for (const a of (attr ?? []) as Array<Record<string, unknown>>) {
    console.log(`  ${String(a.source).padEnd(20)} inquiries=${a.inquiries} tours=${a.tours} bookings=${a.bookings} revenue=${a.revenue} spend=${a.spend}`)
  }

  console.log('\n=== weddings.source rollup (raw) ===')
  const { data: wedd } = await sb
    .from('weddings')
    .select('source, status')
    .eq('venue_id', RIXEY)
  const bySrc = new Map<string, { total: number; booked: number }>()
  for (const w of (wedd ?? []) as Array<{ source: string | null; status: string }>) {
    const s = w.source ?? '(null)'
    const e = bySrc.get(s) ?? { total: 0, booked: 0 }
    e.total++
    if (['booked', 'completed'].includes(w.status)) e.booked++
    bySrc.set(s, e)
  }
  for (const [s, e] of [...bySrc.entries()].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${s.padEnd(20)} total=${e.total} booked=${e.booked}`)
  }

  console.log('\n=== first-touch attribution (touchpoints) ===')
  // First-touch = the source on the wedding's earliest touchpoint
  const { data: tps } = await sb
    .from('wedding_touchpoints')
    .select('wedding_id, source, occurred_at, touch_type')
    .eq('venue_id', RIXEY)
    .order('occurred_at', { ascending: true })
  const firstTouchByWedding = new Map<string, string | null>()
  for (const t of (tps ?? []) as Array<{ wedding_id: string; source: string | null }>) {
    if (!firstTouchByWedding.has(t.wedding_id)) firstTouchByWedding.set(t.wedding_id, t.source)
  }

  const { data: weddingRows } = await sb
    .from('weddings')
    .select('id, status, booking_value')
    .eq('venue_id', RIXEY)
  const wedById = new Map<string, { status: string; value: number }>()
  for (const w of (weddingRows ?? []) as Array<{ id: string; status: string; booking_value: number | null }>) {
    wedById.set(w.id, { status: w.status, value: Number(w.booking_value ?? 0) })
  }

  // Roll up wedding-level metrics by first-touch source
  const ftAgg = new Map<string, { inquiries: number; tours_booked: number; tours_conducted: number; proposals: number; bookings: number; revenue: number }>()

  // For tour/proposal/booking tallies, walk all touchpoints and count by the
  // wedding's first-touch source.
  type TpRow = { wedding_id: string; touch_type: string }
  const allTps = (tps ?? []) as Array<{ wedding_id: string; source: string | null; touch_type: string }>
  // Group touchpoints by wedding
  const tpByWedding = new Map<string, TpRow[]>()
  for (const t of allTps) {
    const arr = tpByWedding.get(t.wedding_id) ?? []
    arr.push({ wedding_id: t.wedding_id, touch_type: t.touch_type })
    tpByWedding.set(t.wedding_id, arr)
  }

  for (const [wid, ft] of firstTouchByWedding) {
    const key = ft ?? '(null)'
    const e = ftAgg.get(key) ?? { inquiries: 0, tours_booked: 0, tours_conducted: 0, proposals: 0, bookings: 0, revenue: 0 }
    e.inquiries++ // every wedding has exactly one inquiry by Phase 1 invariant
    const tps = tpByWedding.get(wid) ?? []
    if (tps.some((t) => t.touch_type === 'tour_booked' || t.touch_type === 'calendly_booked')) e.tours_booked++
    if (tps.some((t) => t.touch_type === 'tour_conducted')) e.tours_conducted++
    if (tps.some((t) => t.touch_type === 'proposal_sent')) e.proposals++
    if (tps.some((t) => t.touch_type === 'contract_signed')) {
      e.bookings++
      e.revenue += wedById.get(wid)?.value ?? 0
    }
    ftAgg.set(key, e)
  }

  for (const [s, e] of [...ftAgg.entries()].sort((a, b) => b[1].inquiries - a[1].inquiries)) {
    const conv = e.inquiries > 0 ? (e.bookings / e.inquiries * 100).toFixed(1) : '0.0'
    console.log(`  ${s.padEnd(20)} inq=${e.inquiries} tour_book=${e.tours_booked} tour_conducted=${e.tours_conducted} prop=${e.proposals} booked=${e.bookings} (${conv}%) rev=$${e.revenue}`)
  }
}

main().catch((err) => { console.error(err); process.exit(1) })
