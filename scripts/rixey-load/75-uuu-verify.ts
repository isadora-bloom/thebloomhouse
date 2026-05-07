/**
 * T5-Rixey-UUU verification script.
 *
 * Asserts the funnel-vs-rollup Knot booking mismatch is fixed.
 *
 * The bug: Source Comparison ("Knot 1 booked") and Compare
 * Attribution Models ("Knot 1 first-touch / 2 last-touch / 1.5 linear")
 * disagreed with /api/intel/sources/wedding-rollup ("Knot 0 booked").
 * computeSourceFunnel was counting bookings via the presence of a
 * contract_signed touchpoint, while wedding-rollup uses
 * weddings.status IN ('booked','completed').
 *
 * For Rixey, wedding dce937fe-7bd9-458c-a565-076028bcf994
 * (status=cancelled, source=the_knot) had a contract_signed
 * touchpoint and was leaking into the Knot booking count under all
 * three models. Status is the truth (per Bloom doctrine — the
 * temporal layer / weddings.status is canonical state, touchpoints
 * are events). The fix gates the `booked` indicator on both:
 *   isTerminal = status IN ('booked','completed')
 *   AND
 *   contract_signed touchpoint present
 *
 * After the fix, all three models must report Knot bookings = 0.
 *
 * Run:
 *   npx tsx scripts/rixey-load/75-uuu-verify.ts
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

function loadEnv() {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  try {
    const raw = readFileSync('.env.local', 'utf8')
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {}
  return env
}

const env = loadEnv()
for (const [k, v] of Object.entries(env)) {
  if (!process.env[k]) process.env[k] = v
}

const RIXEY_VENUE_ID = 'f3d10226-4c5c-47ad-b89b-98ad63842492'

let exitCode = 0
function fail(msg: string) { console.error(`FAIL: ${msg}`); exitCode = 1 }
function pass(msg: string) { console.log(`PASS: ${msg}`) }

async function main() {
  console.log('=== T5-Rixey-UUU verification ===')

  const { computeSourceFunnel } = await import('../../src/lib/services/attribution/index.js')

  // Source-of-truth: per JJJ, no Knot wedding should be in
  // (booked, completed) on Rixey.
  console.log('\n--- A) DB truth (non-merged Knot weddings by terminal status) ---')
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false },
  })
  const { data: knotBooked } = await sb
    .from('weddings')
    .select('id, status')
    .eq('venue_id', RIXEY_VENUE_ID)
    .eq('source', 'the_knot')
    .in('status', ['booked', 'completed'])
    .is('merged_into_id', null)
  const knotTruth = knotBooked?.length ?? 0
  console.log(`  Knot non-merged weddings with status booked/completed: ${knotTruth}`)
  if (knotTruth !== 0) {
    fail(`DB truth says Knot bookings = ${knotTruth} (expected 0). UUU's premise broke; investigate before trusting the test below.`)
  } else {
    pass('DB truth: Knot bookings = 0')
  }

  // For each model, computeSourceFunnel must report Knot bookings = 0.
  for (const model of ['first_touch', 'last_touch', 'linear'] as const) {
    console.log(`\n--- B) computeSourceFunnel(model=${model}) ---`)
    const rows = await computeSourceFunnel(RIXEY_VENUE_ID, { model })
    const knotRow = rows.find((r) => (r.source ?? '').toLowerCase() === 'the_knot')
    const bookings = Number(knotRow?.bookings ?? 0)
    console.log('  Knot row:')
    if (knotRow) {
      console.log(`    source:              ${knotRow.source ?? '(null)'}`)
      console.log(`    inquiries:           ${knotRow.inquiries}`)
      console.log(`    tours_booked:        ${knotRow.tours_booked}`)
      console.log(`    tours_conducted:     ${knotRow.tours_conducted}`)
      console.log(`    proposals_sent:      ${knotRow.proposals_sent}`)
      console.log(`    bookings:            ${knotRow.bookings}`)
      console.log(`    revenue:             $${knotRow.revenue.toLocaleString()}`)
    } else {
      console.log('    (no row returned for the_knot)')
    }
    if (bookings < 0.05) {
      pass(`${model}: Knot bookings ~ 0 (got ${bookings})`)
    } else {
      fail(`${model}: Knot bookings = ${bookings} (expected ~0; status gate not applied)`)
    }
  }

  console.log(exitCode === 0 ? '\nAll checks passed.' : '\nFailures detected.')
  process.exit(exitCode)
}

main().catch((e) => { console.error(e); process.exit(1) })
