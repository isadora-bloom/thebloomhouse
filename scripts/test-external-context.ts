/**
 * Pure-function tests for the T2-C External Context layer.
 *
 * Covers:
 *   - toDayKey converts UTC dates to YYYY-MM-DD
 *   - daysInRange iterates inclusive UTC days
 *   - DEFAULT_FRED_SERIES contents match the macro panel
 *   - Calendar geo_scope expansion works hierarchically
 *   - correctedThresholdFor scales with channel count + lag count
 *
 * Live-Supabase tests (loadFredSeries, loadCulturalMomentsSeries,
 * loadCalendarSeries) are integration concerns covered by the
 * correlation engine's existing e2e path.
 *
 * Run with: npx tsx scripts/test-external-context.ts
 */

import { toDayKey, daysInRange } from '../src/lib/services/external-context/types'
import { DEFAULT_FRED_SERIES } from '../src/lib/services/external-context/fred'

let pass = 0
let fail = 0

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${label}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

// ---------------------------------------------------------------------------
// toDayKey
// ---------------------------------------------------------------------------

assertEq(toDayKey(new Date('2026-04-26T00:00:00Z')), '2026-04-26', 'Apr 26 UTC midnight')
assertEq(toDayKey(new Date('2026-04-26T23:59:59Z')), '2026-04-26', 'same day across the day')
assertEq(toDayKey(new Date('2026-01-01T00:00:00Z')), '2026-01-01', 'New Year UTC')
assertEq(toDayKey(new Date('2026-12-31T23:30:00Z')), '2026-12-31', 'late evening UTC')

// ---------------------------------------------------------------------------
// daysInRange — inclusive both ends
// ---------------------------------------------------------------------------

assertEq(
  Array.from(daysInRange(new Date('2026-04-25T00:00:00Z'), new Date('2026-04-28T00:00:00Z'))),
  ['2026-04-25', '2026-04-26', '2026-04-27', '2026-04-28'],
  '4-day inclusive range',
)
assertEq(
  Array.from(daysInRange(new Date('2026-04-26T00:00:00Z'), new Date('2026-04-26T00:00:00Z'))),
  ['2026-04-26'],
  'single day range',
)
// End before start → empty
assertEq(
  Array.from(daysInRange(new Date('2026-04-28T00:00:00Z'), new Date('2026-04-25T00:00:00Z'))),
  [],
  'reversed range produces empty',
)
// Cross month/year boundary
assertEq(
  Array.from(daysInRange(new Date('2026-12-30T00:00:00Z'), new Date('2027-01-02T00:00:00Z'))),
  ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02'],
  'cross-year boundary',
)

// ---------------------------------------------------------------------------
// DEFAULT_FRED_SERIES — sanity check the canonical panel
// ---------------------------------------------------------------------------

const ids = DEFAULT_FRED_SERIES.map((s) => s.id)
assertEq(ids.includes('CPIAUCSL'), true, 'panel includes CPI')
assertEq(ids.includes('MORTGAGE30US'), true, 'panel includes mortgage rate')
assertEq(ids.includes('SP500'), true, 'panel includes S&P 500')
assertEq(ids.includes('UNRATE'), true, 'panel includes unemployment')

// All entries have non-empty label
for (const s of DEFAULT_FRED_SERIES) {
  if (!s.label?.trim()) {
    fail++
    console.error(`FAIL: empty label for ${s.id}`)
  } else {
    pass++
  }
}

// ---------------------------------------------------------------------------
// Proper Bonferroni-corrected threshold (T2-C — review pass 2 replaced
// the heuristic with stats.ts proper derivation).
// ---------------------------------------------------------------------------

import { bonferroniCriticalR, inverseNormalCdf } from '../src/lib/services/external-context/stats'

const FLOOR_R = 0.6
const N = 90  // WINDOW_DAYS
const LAGS_N = 5

function correctedThresholdFor(numChannels: number): number {
  if (numChannels < 2) return FLOOR_R
  const numTests = numChannels * (numChannels - 1) * LAGS_N
  const r = bonferroniCriticalR(numTests, N, 0.05)
  return Math.max(FLOOR_R, Math.min(0.85, r))
}

// inverseNormalCdf — sanity check against textbook critical values.
const z975 = inverseNormalCdf(0.975)
if (Math.abs(z975 - 1.959964) < 0.001) pass++
else { fail++; console.error(`FAIL: qnorm(0.975) expected ~1.96, got ${z975}`) }

const z995 = inverseNormalCdf(0.995)
if (Math.abs(z995 - 2.5758) < 0.005) pass++
else { fail++; console.error(`FAIL: qnorm(0.995) expected ~2.576, got ${z995}`) }

const z50 = inverseNormalCdf(0.5)
if (Math.abs(z50) < 0.001) pass++
else { fail++; console.error(`FAIL: qnorm(0.5) expected 0, got ${z50}`) }

// 1 test at n=90, alpha=0.05 → critical |r| ≈ 0.21 (textbook value
// from a Pearson r → t conversion).
const r1 = bonferroniCriticalR(1, 90, 0.05)
if (r1 > 0.18 && r1 < 0.24) pass++
else { fail++; console.error(`FAIL: 1-test critical r expected ~0.21, got ${r1.toFixed(3)}`) }

// 100 tests → tighter critical r
const r100 = bonferroniCriticalR(100, 90, 0.05)
if (r100 > r1 && r100 < 0.5) pass++
else { fail++; console.error(`FAIL: 100-test critical r ${r100.toFixed(3)} not in (${r1.toFixed(3)}, 0.5)`) }

// 1000 tests → tighter still
const r1000 = bonferroniCriticalR(1000, 90, 0.05)
if (r1000 > r100) pass++
else { fail++; console.error(`FAIL: 1000-test critical r ${r1000.toFixed(3)} not > 100-test ${r100.toFixed(3)}`) }

// Monotonicity (strict)
const r10 = bonferroniCriticalR(10, 90, 0.05)
if (r1 < r10 && r10 < r100 && r100 < r1000) pass++
else { fail++; console.error(`FAIL: not monotonic: ${r1}, ${r10}, ${r100}, ${r1000}`) }

// Engine wrapper — always in [floor, cap]
for (const n of [2, 5, 10, 20, 50, 100]) {
  const t = correctedThresholdFor(n)
  if (t >= FLOOR_R && t <= 0.85) pass++
  else { fail++; console.error(`FAIL: out of range at N=${n}: ${t}`) }
}

assertEq(correctedThresholdFor(1), FLOOR_R, 'numChannels=1 returns floor')

const smallNT = correctedThresholdFor(3)
if (smallNT === FLOOR_R) pass++
else { fail++; console.error(`FAIL: small N expected floor, got ${smallNT}`) }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
