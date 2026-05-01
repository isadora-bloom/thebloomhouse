/**
 * Unit tests — source-mix-counterfactual pure helpers (T3-G INS-19.5.1).
 *
 * Targets bandaid traps the design wanted to avoid:
 *   - Linear extrapolation (concave sqrt curve verified)
 *   - Eligibility filter rejects sources without sufficient signal
 *   - Pair selection picks worst-CAC + best-CAC (not random / not adjacent)
 *   - Reallocation projection arithmetic is sign-correct (donor LOSS,
 *     recipient GAIN, net delta = gain - loss)
 *   - Attribution-quality flag fires when auto-link rates diverge >30pp
 *   - bookingsAt(0) = 0 (clean handling of "remove all budget")
 */

import { __test__ } from '../src/lib/services/insights/source-mix-counterfactual'

const {
  bookingsAt,
  marginalBookingsDelta,
  pickPair,
  eligibleSourcesFromScorecard,
  projectReallocation,
  MIN_SOURCE_BOOKINGS,
  ATTRIBUTION_QUALITY_GAP_PP,
  REALLOCATION_PCT,
} = __test__

let pass = 0
let fail = 0

function assert(cond: unknown, label: string) {
  if (cond) {
    console.log(`  ✓ ${label}`)
    pass++
  } else {
    console.error(`  ✗ ${label}`)
    fail++
  }
}

function approxEq(a: number, b: number, tol: number = 0.01): boolean {
  return Math.abs(a - b) < tol
}

console.log('\n=== bookingsAt — concave sqrt curve ===')
{
  // Calibrate a from $1000 spend → 5 bookings: a = 5/sqrt(1000) ≈ 0.158
  const a = 5 / Math.sqrt(1000)
  assert(bookingsAt(0, a) === 0, 'spend=0 → 0 bookings (clean budget removal)')
  assert(approxEq(bookingsAt(1000, a), 5), 'spend = current → bookings = current')
  // Doubling spend should NOT double bookings (concave).
  // bookings(2000) = a*sqrt(2000) ≈ 0.158 * 44.7 ≈ 7.07 (not 10).
  assert(bookingsAt(2000, a) < 8, 'doubling spend < doubling bookings (diminishing returns)')
  assert(bookingsAt(2000, a) > 6, 'doubling spend > 1.4x bookings (not flat either)')
}

console.log('\n=== marginalBookingsDelta — sign correctness ===')
{
  const a = 5 / Math.sqrt(1000)
  // Add 500 spend at current 1000 → marginal gain
  assert(marginalBookingsDelta(1000, +500, a) > 0, 'positive deltaSpend → positive bookings delta')
  // Remove 500 spend at current 1000 → marginal loss
  assert(marginalBookingsDelta(1000, -500, a) < 0, 'negative deltaSpend → negative bookings delta')
  // Reduce to negative spend → bookingsAt clamps to 0; delta = 0 - 5 = -5
  assert(marginalBookingsDelta(1000, -2000, a) === -5, 'remove > current spend → loss = current bookings (no negative bookings)')
}

console.log('\n=== eligibleSourcesFromScorecard ===')
{
  const rows = [
    // qualifying
    { source: 'instagram', spendInWindow: 5000, firstTouchBookings: 4, costPerBooking: 1250, autoLinkRate: 0.7 },
    { source: 'the_knot', spendInWindow: 8000, firstTouchBookings: 6, costPerBooking: 1333, autoLinkRate: 0.6 },
    { source: 'google',   spendInWindow: 3000, firstTouchBookings: 3, costPerBooking: 1000, autoLinkRate: 0.5 },
    // disqualifying — too few bookings
    { source: 'pinterest', spendInWindow: 1000, firstTouchBookings: 1, costPerBooking: 1000, autoLinkRate: 0.4 },
    // disqualifying — no spend
    { source: 'referral',  spendInWindow: 0, firstTouchBookings: 5, costPerBooking: null, autoLinkRate: 0.9 },
    // disqualifying — null CAC
    { source: 'walk_in',   spendInWindow: 100, firstTouchBookings: 2, costPerBooking: null, autoLinkRate: 0.5 },
  ]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const eligible = eligibleSourcesFromScorecard(rows as any)
  assert(eligible.length === 3, 'three qualifying sources')
  const names = eligible.map((s) => s.source).sort()
  assert(JSON.stringify(names) === JSON.stringify(['google', 'instagram', 'the_knot']), 'names match expected qualifying set')
  // responseCoefficient = bookings / sqrt(spend)
  const ig = eligible.find((s) => s.source === 'instagram')!
  assert(approxEq(ig.responseCoefficient, 4 / Math.sqrt(5000)), 'response coefficient = bookings / sqrt(spend)')
}

console.log('\n=== pickPair — extremes by CAC ===')
{
  const eligible = [
    { source: 'a', spendInWindow: 1000, firstTouchBookings: 5, costPerBooking: 200, autoLinkRate: 0.5, responseCoefficient: 0.158 },
    { source: 'b', spendInWindow: 1000, firstTouchBookings: 2, costPerBooking: 500, autoLinkRate: 0.5, responseCoefficient: 0.063 },
    { source: 'c', spendInWindow: 1000, firstTouchBookings: 1, costPerBooking: 1000, autoLinkRate: 0.5, responseCoefficient: 0.032 },
  ]
  const pair = pickPair(eligible)
  assert(pair !== null, 'pair selected')
  assert(pair?.donor.source === 'c', 'donor = highest CAC')
  assert(pair?.recipient.source === 'a', 'recipient = lowest CAC')
}
{
  const eligible = [
    { source: 'only', spendInWindow: 1000, firstTouchBookings: 5, costPerBooking: 200, autoLinkRate: 0.5, responseCoefficient: 0.158 },
  ]
  assert(pickPair(eligible) === null, 'single source → no pair')
}

console.log('\n=== projectReallocation — sign + flag correctness ===')
{
  const donor = {
    source: 'high_cac',
    spendInWindow: 10_000,
    firstTouchBookings: 2,
    costPerBooking: 5000,
    autoLinkRate: 0.5,
    responseCoefficient: 2 / Math.sqrt(10_000),  // 0.02
  }
  const recipient = {
    source: 'low_cac',
    spendInWindow: 5_000,
    firstTouchBookings: 5,
    costPerBooking: 1000,
    autoLinkRate: 0.5,
    responseCoefficient: 5 / Math.sqrt(5_000),  // 0.0707
  }
  const proj = projectReallocation(donor, recipient)
  // Reallocation = REALLOCATION_PCT * 10_000 = $2000
  assert(proj.reallocation_amount === Math.round(REALLOCATION_PCT * 10_000), `reallocation = ${REALLOCATION_PCT * 100}% of donor spend`)
  assert(proj.projected_donor_loss > 0, 'donor LOSS is positive (sign-flipped from negative delta)')
  assert(proj.projected_recipient_gain > 0, 'recipient GAIN is positive')
  // Both delta and gain/loss are independently rounded to 2 decimals, so
  // the comparison can drift up to ±0.01 from cross-rounding. Approx-eq.
  assert(approxEq(proj.projected_delta_bookings, proj.projected_recipient_gain - proj.projected_donor_loss, 0.02), 'net delta ≈ gain - loss (within rounding)')
  // CAC ratio = 5000 / 1000 = 5
  assert(proj.cac_ratio === 5, 'cac_ratio = donor_cpb / recipient_cpb')
  // Attribution quality flag OFF (auto-link rates equal).
  assert(proj.attribution_quality_gap_flag === false, 'equal autoLinkRate → flag OFF')
}
{
  // Same as above but recipient autoLinkRate is +30pp higher.
  const donor = {
    source: 'high_cac', spendInWindow: 10_000, firstTouchBookings: 2,
    costPerBooking: 5000, autoLinkRate: 0.4, responseCoefficient: 0.02,
  }
  const recipient = {
    source: 'low_cac', spendInWindow: 5_000, firstTouchBookings: 5,
    costPerBooking: 1000, autoLinkRate: 0.7, responseCoefficient: 0.0707,
  }
  const proj = projectReallocation(donor, recipient)
  assert(proj.attribution_quality_gap_flag === true, `autoLinkRate gap >= ${ATTRIBUTION_QUALITY_GAP_PP}pp → flag ON`)
}
{
  // Edge: 29pp gap → flag should be OFF (just under threshold).
  const donor = {
    source: 'a', spendInWindow: 10_000, firstTouchBookings: 2,
    costPerBooking: 5000, autoLinkRate: 0.4, responseCoefficient: 0.02,
  }
  const recipient = {
    source: 'b', spendInWindow: 5_000, firstTouchBookings: 5,
    costPerBooking: 1000, autoLinkRate: 0.69, responseCoefficient: 0.0707,
  }
  const proj = projectReallocation(donor, recipient)
  assert(proj.attribution_quality_gap_flag === false, 'autoLinkRate gap < 30pp → flag OFF')
}

assert(MIN_SOURCE_BOOKINGS === 2, 'MIN_SOURCE_BOOKINGS=2 (matches design constant)')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
