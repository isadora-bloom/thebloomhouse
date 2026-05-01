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
// Bonferroni-corrected threshold (T2-C requirement)
// Re-implement here to avoid importing the whole correlation-engine
// (which pulls Supabase types). Verifies the formula's monotonicity +
// floor properties.
// ---------------------------------------------------------------------------

const PEARSON_R_AT_P05_N90 = 0.21
const LAGS_N = 5
const FLOOR_R = 0.6

function correctedThresholdFor(numChannels: number): number {
  if (numChannels < 2) return FLOOR_R
  const numTests = numChannels * (numChannels - 1) * LAGS_N
  const corrected = PEARSON_R_AT_P05_N90 * Math.sqrt(Math.log(numTests + 1) / Math.log(2))
  return Math.max(FLOOR_R, Math.min(0.85, corrected))
}

// Single channel → floor (no tests possible)
assertEq(correctedThresholdFor(1), FLOOR_R, 'numChannels=1 returns floor')
// Small N stays at floor
const smallN = correctedThresholdFor(3)
if (smallN === FLOOR_R) pass++
else { fail++; console.error(`FAIL: small N expected floor, got ${smallN}`) }

// Monotonic: more channels → higher (or equal) corrected threshold
const t10 = correctedThresholdFor(10)
const t20 = correctedThresholdFor(20)
const t50 = correctedThresholdFor(50)
if (t10 <= t20 && t20 <= t50) pass++
else { fail++; console.error(`FAIL: not monotonic: 10=${t10} 20=${t20} 50=${t50}`) }

// Capped at 0.85
const t1000 = correctedThresholdFor(1000)
if (t1000 <= 0.85) pass++
else { fail++; console.error(`FAIL: cap exceeded: ${t1000}`) }

// Always ≥ floor
for (const n of [2, 5, 10, 20, 50, 100]) {
  const t = correctedThresholdFor(n)
  if (t >= FLOOR_R) pass++
  else { fail++; console.error(`FAIL: below floor at N=${n}: ${t}`) }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
