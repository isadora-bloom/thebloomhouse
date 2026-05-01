/**
 * Unit tests — cohort-match pure helpers (T3-D INS-19.3.6).
 *
 * Targets the bandaid traps the design wanted to avoid:
 *   - season derivation from a date string (not localised; always
 *     UTC month buckets so day-of-month doesn't drift across TZ)
 *   - planning-horizon arithmetic (inquiry → wedding_date)
 *   - mean/std calculation under tiny samples (must not return NaN)
 *   - median over even/odd lengths
 *   - dimSimilarity null-handling — present-only dims, no spurious 0s
 *   - combineSimilarity weight renormalisation when only some dims
 *     are comparable
 */

import {
  __test__,
} from '../src/lib/services/insights/cohort-match'

const { deriveSeason, dayOfWeek, planningHorizon, meanStd, median, dimSimilarity, combineSimilarity } = __test__

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

function approxEq(a: number, b: number, tol: number = 1e-6): boolean {
  return Math.abs(a - b) < tol
}

console.log('\n=== deriveSeason ===')
assert(deriveSeason('2026-01-15') === 'winter', 'January → winter')
assert(deriveSeason('2026-02-29') === 'winter', 'Feb → winter')
assert(deriveSeason('2026-03-15') === 'spring', 'March → spring')
assert(deriveSeason('2026-05-31') === 'spring', 'May → spring')
assert(deriveSeason('2026-06-01') === 'summer', 'June → summer')
assert(deriveSeason('2026-08-31') === 'summer', 'August → summer')
assert(deriveSeason('2026-09-15') === 'fall', 'September → fall')
assert(deriveSeason('2026-11-30') === 'fall', 'November → fall')
assert(deriveSeason('2026-12-25') === 'winter', 'December → winter')
assert(deriveSeason(null) === null, 'null → null (no date no season)')
assert(deriveSeason('not-a-date') === null, 'malformed → null (no NaN bug)')

console.log('\n=== dayOfWeek ===')
// 2026-05-02 is a Saturday in UTC.
assert(dayOfWeek('2026-05-02') === 6, '2026-05-02 → Saturday (6)')
// 2026-05-03 is a Sunday.
assert(dayOfWeek('2026-05-03') === 0, '2026-05-03 → Sunday (0)')
assert(dayOfWeek(null) === null, 'null → null')
assert(dayOfWeek('garbage') === null, 'malformed → null')

console.log('\n=== planningHorizon ===')
// wedding_date is anchored to noon UTC inside the function (so a date-
// only string + a non-zero TZ offset don't drift across day boundaries).
// Tests anchor inquiry to the same noon for clean integer expectations.
assert(
  planningHorizon('2025-05-01T12:00:00Z', '2026-05-01') === 365,
  '1 year horizon = 365 days',
)
assert(
  planningHorizon('2026-04-01T12:00:00Z', '2026-05-01') === 30,
  '30-day horizon',
)
assert(planningHorizon(null, '2026-05-01') === null, 'null inquiry → null')
assert(planningHorizon('2026-04-01T00:00:00Z', null) === null, 'null wedding_date → null')

console.log('\n=== meanStd ===')
{
  const r = meanStd([10, 20, 30])
  assert(approxEq(r.mean, 20), 'mean of [10,20,30] = 20')
  assert(approxEq(r.std, 10), 'sample std of [10,20,30] = 10')
}
{
  const r = meanStd([])
  assert(r.mean === 0, 'empty array mean = 0')
  assert(r.std === 1, 'empty array std = 1 (no NaN bug)')
}
{
  const r = meanStd([42])
  assert(r.mean === 42, 'single-element mean = the value')
  assert(r.std === 1, 'single-element std = 1 (graceful, no NaN)')
}
{
  // Constant values → std should not collapse to 0 (would div-by-zero
  // in z-score). Code returns 1 in that case.
  const r = meanStd([5, 5, 5, 5])
  assert(r.mean === 5, 'constant mean')
  assert(r.std === 1, 'constant array std = 1 (no z-score div-by-zero)')
}

console.log('\n=== median ===')
assert(median([]) === null, 'empty → null')
assert(median([5]) === 5, 'single = the value')
assert(median([1, 3, 2]) === 2, 'odd length = middle')
assert(median([1, 2, 3, 4]) === 2.5, 'even length = avg of two middles')
assert(median([10, 20, 30, 40, 50, 60]) === 35, 'six elements = (30+40)/2')

console.log('\n=== dimSimilarity ===')
const venueStats = {
  guest_count_mean: 100,
  guest_count_std: 30,
  horizon_mean: 365,
  horizon_std: 90,
}
const baseFeatures = {
  weddingId: 'a',
  status: 'inquiry',
  guest_count: 100,
  season: 'spring' as const,
  planning_horizon_days: 365,
  source: 'instagram',
  day_of_week: 6,
  wedding_date: null,
  inquiry_date: null,
  booking_value: null,
  booked_at: null,
}
{
  // Identical features → similarity == 1 on every comparable dim.
  const d = dimSimilarity(baseFeatures, baseFeatures, venueStats)
  assert(approxEq(d.gc!, 1), 'identical guest count → gc=1')
  assert(d.season === 1, 'identical season → 1')
  assert(approxEq(d.horizon!, 1), 'identical horizon → 1')
  assert(d.source === 1, 'identical source → 1')
  assert(d.dow === 1, 'identical dow → 1')
}
{
  // Drop guest_count on candidate → gc is null (not 0), caller
  // re-normalises weights.
  const cand = { ...baseFeatures, weddingId: 'b', guest_count: null }
  const d = dimSimilarity(baseFeatures, cand, venueStats)
  assert(d.gc === null, 'null guest_count on candidate → null (not 0)')
  assert(d.season === 1, 'season still comparable')
  assert(d.source === 1, 'source still comparable')
}
{
  // 1-stddev away on guest count → exp(-1) ≈ 0.368.
  const cand = { ...baseFeatures, weddingId: 'b', guest_count: 130 }
  const d = dimSimilarity(baseFeatures, cand, venueStats)
  assert(d.gc !== null && approxEq(d.gc, Math.exp(-1), 0.001), '1σ apart → e^-1 similarity')
}
{
  // Different categorical → 0.
  const cand = { ...baseFeatures, weddingId: 'b', source: 'the_knot' }
  const d = dimSimilarity(baseFeatures, cand, venueStats)
  assert(d.source === 0, 'different source → 0')
}

console.log('\n=== combineSimilarity ===')
{
  // All present + all 1.0 → combined = 1.0.
  const c = combineSimilarity({ gc: 1, season: 1, horizon: 1, source: 1, dow: 1 })
  assert(approxEq(c.value, 1), 'all 1s → combined 1')
  assert(c.dimsUsed === 5, 'dimsUsed = 5')
}
{
  // All null → 0/0 protection — should return value=0, dimsUsed=0.
  const c = combineSimilarity({ gc: null, season: null, horizon: null, source: null, dow: null })
  assert(c.value === 0, 'all-null → value 0 (no NaN)')
  assert(c.dimsUsed === 0, 'all-null → dimsUsed 0')
}
{
  // Only guest_count present, value 0.5. Weight-normalised → 0.5.
  const c = combineSimilarity({ gc: 0.5, season: null, horizon: null, source: null, dow: null })
  assert(approxEq(c.value, 0.5), 'single-dim renormalises (no fake 0s)')
  assert(c.dimsUsed === 1, 'one dim used')
}
{
  // Mixed: gc=1 (weight 1.0), source=0 (weight 0.5). Total = 1*1+0*0.5 = 1; weight = 1.5; combined = 0.667.
  const c = combineSimilarity({ gc: 1, season: null, horizon: null, source: 0, dow: null })
  assert(approxEq(c.value, 1.0 / 1.5, 0.001), 'mixed dims weight-normalised correctly')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
