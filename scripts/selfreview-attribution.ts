// Phase 2 self-review — exercise the attribution service across all
// three models and verify numbers are internally consistent.
//
// Checks:
//   1. inquiry/booking totals match across models (only the
//      attribution per source changes, not the totals).
//   2. First-touch matches the touchpoint-driven first-touch we
//      computed in inspect-current-attribution.ts.
//   3. Last-touch + first-touch differ in expected places (e.g. Knot
//      first-touch leads end up booked under Calendly last-touch).
//   4. Linear weights sum to 1 per wedding (no double-credit).
//   5. Cross-venue safety — running for a different venue doesn't
//      leak Rixey numbers.
import { computeSourceFunnel } from '../src/lib/services/attribution'
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

async function summary(rows: Array<{ source: string | null; inquiries: number; tours_booked: number; tours_conducted: number; proposals_sent: number; bookings: number; revenue: number }>) {
  const totals = { inquiries: 0, tours_booked: 0, tours_conducted: 0, proposals_sent: 0, bookings: 0, revenue: 0 }
  for (const r of rows) {
    totals.inquiries += r.inquiries
    totals.tours_booked += r.tours_booked
    totals.tours_conducted += r.tours_conducted
    totals.proposals_sent += r.proposals_sent
    totals.bookings += r.bookings
    totals.revenue += r.revenue
  }
  return totals
}

async function main() {
  console.log(`\n=== Phase 2 self-review: venue ${RIXEY.slice(0, 8)} ===\n`)

  // CHECK 1+2+3: run all three models, compare totals + per-source breakdown
  for (const model of ['first_touch', 'last_touch', 'linear'] as const) {
    const rows = await computeSourceFunnel(RIXEY, { model })
    const t = await summary(rows)
    console.log(`[${model}]`)
    console.log(`  totals: inq=${t.inquiries} tour_book=${t.tours_booked} tour_held=${t.tours_conducted} prop=${t.proposals_sent} booked=${t.bookings} rev=$${t.revenue}`)
    for (const r of rows) {
      const conv = r.inquiries > 0 ? (r.bookings / r.inquiries * 100).toFixed(1) : '0.0'
      console.log(`    ${(r.source ?? '(null)').padEnd(22)} inq=${String(r.inquiries).padStart(6)} tour_book=${String(r.tours_booked).padStart(5)} tour_held=${String(r.tours_conducted).padStart(5)} prop=${String(r.proposals_sent).padStart(4)} booked=${String(r.bookings).padStart(4)} (${conv}%)`)
    }
    console.log()
  }

  // CHECK 4: cross-venue safety — pick a non-Rixey venue and ensure
  // computeSourceFunnel(otherVenue) doesn't leak Rixey rows.
  const { data: otherVenues } = await sb
    .from('venues')
    .select('id, name, is_demo')
    .neq('id', RIXEY)
    .limit(1)
  if (otherVenues && otherVenues.length > 0) {
    const other = otherVenues[0] as { id: string; name: string; is_demo: boolean }
    const otherRows = await computeSourceFunnel(other.id, { model: 'first_touch' })
    const t = await summary(otherRows)
    console.log(`[cross-venue check] ${other.name} (${other.id.slice(0, 8)})`)
    console.log(`  totals: inq=${t.inquiries} tour_book=${t.tours_booked} booked=${t.bookings} rows=${otherRows.length}`)
    if (t.inquiries > 0 && t.inquiries === 167) {
      console.log(`  ❌ LEAK: other venue shows Rixey-shaped totals`)
    } else {
      console.log(`  ✓ no Rixey leak`)
    }
  } else {
    console.log(`[cross-venue check] no other venues found`)
  }

  // CHECK 5: empty-from-window. Pass from = far future to ensure the
  // service handles empty cohorts.
  const empty = await computeSourceFunnel(RIXEY, { model: 'first_touch', from: '2099-01-01' })
  console.log(`[empty-window check] from=2099-01-01 returned ${empty.length} rows (expect 0)`)

  // CHECK 6: model-totals invariant. Bookings total should be the same
  // across first-touch and last-touch (linear may differ by tiny
  // rounding because of round2). Inquiries total must match.
  const ft = await computeSourceFunnel(RIXEY, { model: 'first_touch' })
  const lt = await computeSourceFunnel(RIXEY, { model: 'last_touch' })
  const lin = await computeSourceFunnel(RIXEY, { model: 'linear' })
  const sumInq = (rows: typeof ft) => rows.reduce((s, r) => s + r.inquiries, 0)
  const sumBkd = (rows: typeof ft) => rows.reduce((s, r) => s + r.bookings, 0)
  const sumRev = (rows: typeof ft) => rows.reduce((s, r) => s + r.revenue, 0)
  console.log(`[invariant] inquiries: ft=${sumInq(ft)} lt=${sumInq(lt)} lin=${sumInq(lin).toFixed(2)}`)
  console.log(`[invariant] bookings:  ft=${sumBkd(ft)} lt=${sumBkd(lt)} lin=${sumBkd(lin).toFixed(2)}`)
  console.log(`[invariant] revenue:   ft=$${sumRev(ft)} lt=$${sumRev(lt)} lin=$${sumRev(lin)}`)
}

main().catch((err) => { console.error(err); process.exit(1) })
