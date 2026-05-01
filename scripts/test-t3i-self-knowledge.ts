/**
 * Unit tests — T3-I self-knowledge insights.
 *
 * Two services covered:
 *   coordinator-override-pattern: actionMix percentages,
 *     dowRejectionAnomalies threshold + sample-size guards
 *   strength-area-cohort: bandForGuestCount edges,
 *     computeBandStats conversion math + qualifying flag
 *
 * Bandaid traps targeted:
 *   - Day-of-week anomaly fired on tiny sample (n=2) → must require >=5
 *   - Sub-threshold pp diff still flagged → must require >=20pp
 *   - 200-guest wedding misbucketed → must land in '200+' band
 *   - Band qualification at boundary 4 vs 5 weddings
 *   - actionMix percentages sum to ~100 (rounding-safe)
 */

import { __test__ as coordTest } from '../src/lib/services/insights/coordinator-override-pattern'
import { __test__ as strengthTest } from '../src/lib/services/insights/strength-area-cohort'

const { actionMix, dowRejectionAnomalies, MIN_PER_DOW_FEEDBACK, DOW_ANOMALY_PP_THRESHOLD } = coordTest
const { bandForGuestCount, computeBandStats, MIN_PER_BAND_RESOLVED } = strengthTest

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

function approxEq(a: number, b: number, tol: number = 0.5): boolean {
  return Math.abs(a - b) < tol
}

console.log('\n=== coordinator-override / actionMix ===')
{
  const rows = [
    { action: 'approved' as const, created_at: '2026-04-01T10:00:00Z', draft_id: 'a' },
    { action: 'approved' as const, created_at: '2026-04-01T10:00:00Z', draft_id: 'b' },
    { action: 'approved' as const, created_at: '2026-04-01T10:00:00Z', draft_id: 'c' },
    { action: 'edited' as const,   created_at: '2026-04-01T10:00:00Z', draft_id: 'd' },
    { action: 'rejected' as const, created_at: '2026-04-01T10:00:00Z', draft_id: 'e' },
  ]
  const m = actionMix(rows)
  assert(m.total === 5, 'total = 5')
  assert(m.approved === 3, 'approved = 3')
  assert(m.edited === 1, 'edited = 1')
  assert(m.rejected === 1, 'rejected = 1')
  assert(approxEq(m.approved_pct + m.edited_pct + m.rejected_pct, 100, 0.5), 'percentages sum to ~100 (rounding-safe)')
  assert(m.approved_pct === 60, 'approved_pct = 60')
}
{
  const m = actionMix([])
  assert(m.total === 0, 'empty input → total 0')
  assert(m.approved_pct === 0, 'empty input → 0% (no NaN)')
}

console.log('\n=== coordinator-override / dowRejectionAnomalies ===')
function feedback(action: 'approved' | 'edited' | 'rejected', dateIso: string) {
  return { action, created_at: dateIso, draft_id: dateIso }
}
{
  // No anomalies if all bins below MIN_PER_DOW_FEEDBACK.
  const rows = [
    feedback('rejected', '2026-04-07T12:00:00Z'),  // Tuesday
    feedback('rejected', '2026-04-14T12:00:00Z'),  // Tuesday
  ]
  const an = dowRejectionAnomalies(rows)
  assert(an.length === 0, `< ${MIN_PER_DOW_FEEDBACK} per day → no anomaly even at 100% rejection`)
}
{
  // Tuesday: 5 rejected of 5 → 100% rejected. Other days: 5 approved of 5 → 0% rejected.
  // Overall mean = 5/15 = 33.3%. Tuesday diff = 100 - 33.3 = 66.7pp > 20pp.
  // Hard-coded valid Tue/Wed/Thu dates in April-May 2026 (UTC). Earlier
  // version tried `2026-04-${7 + i*7}` which overflowed to invalid
  // 2026-04-35 on iteration 4.
  const tuesdays = ['2026-04-07', '2026-04-14', '2026-04-21', '2026-04-28', '2026-05-05']
  const wednesdays = ['2026-04-08', '2026-04-15', '2026-04-22', '2026-04-29', '2026-05-06']
  const thursdays = ['2026-04-09', '2026-04-16', '2026-04-23', '2026-04-30', '2026-05-07']
  const rows: ReturnType<typeof feedback>[] = []
  for (const d of tuesdays)   rows.push(feedback('rejected', `${d}T12:00:00Z`))
  for (const d of wednesdays) rows.push(feedback('approved', `${d}T12:00:00Z`))
  for (const d of thursdays)  rows.push(feedback('approved', `${d}T12:00:00Z`))
  const an = dowRejectionAnomalies(rows)
  const tue = an.find((a) => a.day_label === 'Tue')
  assert(tue !== undefined, 'Tuesday anomaly flagged')
  assert(tue !== undefined && tue.rejected_pct === 100, 'Tuesday rejected_pct = 100')
  assert(tue !== undefined && Math.abs(tue.diff_from_mean_pp) >= DOW_ANOMALY_PP_THRESHOLD, `diff >= ${DOW_ANOMALY_PP_THRESHOLD}pp`)
}
{
  // Borderline: build a set where Tue diff from overall mean is ~0pp.
  // 6 Tue approved + 2 Tue rejected → Tue: 25% rejected of 8.
  // Overall: 2 rejected of 8 = 25%. diff = 0pp. No anomaly.
  const tuesdays = ['2026-04-07', '2026-04-14', '2026-04-21', '2026-04-28', '2026-05-05', '2026-05-12', '2026-05-19', '2026-05-26']
  const rows: ReturnType<typeof feedback>[] = []
  for (let i = 0; i < 6; i++) rows.push(feedback('approved', `${tuesdays[i]}T12:00:00Z`))
  for (let i = 6; i < 8; i++) rows.push(feedback('rejected', `${tuesdays[i]}T12:00:00Z`))
  const an = dowRejectionAnomalies(rows)
  assert(an.length === 0, 'sub-threshold diff → no anomaly')
}

console.log('\n=== strength-area / bandForGuestCount ===')
assert(bandForGuestCount(0) === '0-50', '0 → 0-50')
assert(bandForGuestCount(50) === '0-50', '50 → 0-50')
assert(bandForGuestCount(51) === '51-100', '51 → 51-100')
assert(bandForGuestCount(100) === '51-100', '100 → 51-100')
assert(bandForGuestCount(101) === '101-150', '101 → 101-150')
assert(bandForGuestCount(150) === '101-150', '150 → 101-150')
assert(bandForGuestCount(151) === '151-200', '151 → 151-200')
assert(bandForGuestCount(200) === '151-200', '200 → 151-200 (boundary)')
assert(bandForGuestCount(201) === '200+', '201 → 200+')
assert(bandForGuestCount(500) === '200+', '500 → 200+')
assert(bandForGuestCount(null) === null, 'null → null')
assert(bandForGuestCount(-5) === null, 'negative → null (invalid)')

console.log('\n=== strength-area / computeBandStats ===')
{
  // 6 weddings in 51-100, 4 of which booked. 4 weddings in 101-150,
  // 1 booked. 51-100 should qualify (n=6 >= 5); 101-150 should not (n=4).
  const rows = [
    ...Array(4).fill(0).map(() => ({ status: 'booked', guest_count_estimate: 75 })),
    ...Array(2).fill(0).map(() => ({ status: 'lost', guest_count_estimate: 80 })),
    ...Array(1).fill(0).map(() => ({ status: 'booked', guest_count_estimate: 130 })),
    ...Array(3).fill(0).map(() => ({ status: 'lost', guest_count_estimate: 130 })),
  ]
  const stats = computeBandStats(rows)
  const band51 = stats.find((s) => s.label === '51-100')!
  const band101 = stats.find((s) => s.label === '101-150')!
  assert(band51.resolved === 6, '51-100 resolved = 6')
  assert(band51.booked === 4, '51-100 booked = 4')
  assert(approxEq(band51.conversion_pct, 66.7, 0.1), '51-100 conversion ≈ 66.7%')
  assert(band51.qualifies === true, `51-100 qualifies (>= ${MIN_PER_BAND_RESOLVED})`)
  assert(band101.resolved === 4, '101-150 resolved = 4')
  assert(band101.qualifies === false, `101-150 NOT qualifies (< ${MIN_PER_BAND_RESOLVED})`)
}
{
  // status=tour_scheduled is excluded from both numerator AND denominator.
  // 5 tour_scheduled in 51-100 + 0 booked + 0 lost → resolved 0, qualifies false.
  const rows = Array(5).fill(0).map(() => ({ status: 'tour_scheduled', guest_count_estimate: 75 }))
  const stats = computeBandStats(rows)
  const band = stats.find((s) => s.label === '51-100')!
  assert(band.resolved === 0, 'in-flight statuses excluded from resolved count')
  assert(band.qualifies === false, 'in-flight only → does not qualify')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
