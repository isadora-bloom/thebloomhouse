/**
 * Pure-function tests for the T3 insight foundation:
 *   - confidenceFor() sample-size + effect-size aware scoring
 *   - buildCacheKey() deterministic + order-stable hashing
 *   - checkNarrationNumbers() numbers-guard
 *
 * The actual insight generators (heat-narration, negotiation-state,
 * risk-flags) require live Supabase + LLM calls; covered by the
 * existing integration test pattern when needed.
 *
 * Run with: npx tsx scripts/test-insights-foundation.ts
 */

import { confidenceFor, buildCacheKey } from '../src/lib/services/insights/confidence'
import { checkNarrationNumbers } from '../src/lib/services/insights/numbers-guard'

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

function assertWithin(actual: number, expected: number, tolerance: number, label: string): void {
  if (Math.abs(actual - expected) <= tolerance) pass++
  else {
    fail++
    console.error(`FAIL: ${label}\n  expected ${expected} ± ${tolerance}\n  actual: ${actual}`)
  }
}

// ---------------------------------------------------------------------------
// confidenceFor — sample-size + effect-size aware
// ---------------------------------------------------------------------------

// Tiny sample → low confidence regardless of effect
const tinyHigh = confidenceFor({ sampleSize: 3, effectSize: 0.9 })
assertEq(tinyHigh.level, 'low', 'tiny sample + huge effect still low')
if (tinyHigh.value <= 0.4) pass++
else { fail++; console.error(`FAIL: tiny sample value > 0.4: ${tinyHigh.value}`) }

// Large sample + clear effect → high
const bigClear = confidenceFor({ sampleSize: 150, effectSize: 0.7 })
assertEq(bigClear.level, 'high', 'big sample + clear effect → high')
if (bigClear.value >= 0.7) pass++
else { fail++; console.error(`FAIL: big sample value < 0.7: ${bigClear.value}`) }

// Medium sample + middling effect → medium
const mid = confidenceFor({ sampleSize: 25, effectSize: 0.5 })
assertEq(mid.level, 'medium', 'mid sample + mid effect → medium')

// Large sample + clear effect floor — at N=100, effect=0.5 floors to >=0.7
const bigFloor = confidenceFor({ sampleSize: 100, effectSize: 0.5 })
if (bigFloor.value >= 0.7) pass++
else { fail++; console.error(`FAIL: N=100 effect=0.5 floor: ${bigFloor.value}`) }

// effectSize default = 0.5
const noEffect = confidenceFor({ sampleSize: 50 })
if (noEffect.value > 0 && noEffect.value < 1) pass++
else { fail++; console.error(`FAIL: missing effect default: ${noEffect.value}`) }

// Edge: 0 sample size
assertEq(confidenceFor({ sampleSize: 0 }).level, 'low', '0 sample → low')

// Edge: huge effect, decent sample → still bounded ≤1
const cap = confidenceFor({ sampleSize: 1000, effectSize: 1 })
if (cap.value <= 1.0) pass++
else { fail++; console.error(`FAIL: confidence > 1: ${cap.value}`) }

// ---------------------------------------------------------------------------
// buildCacheKey — deterministic + order-stable
// ---------------------------------------------------------------------------

const k1 = buildCacheKey({ a: 1, b: 'x', c: [1, 2, 3] })
const k2 = buildCacheKey({ c: [1, 2, 3], a: 1, b: 'x' }) // different key order
assertEq(k1, k2, 'cache key is order-stable across input key insertion order')

const k3 = buildCacheKey({ a: 1 })
const k4 = buildCacheKey({ a: 2 })
if (k3 !== k4) pass++
else { fail++; console.error('FAIL: different inputs produce same key') }

// 8-char lowercase hex
if (/^[0-9a-f]{8}$/.test(k1)) pass++
else { fail++; console.error(`FAIL: cache key shape: ${k1}`) }

// Empty input doesn't crash
const kEmpty = buildCacheKey({})
if (typeof kEmpty === 'string' && kEmpty.length === 8) pass++
else { fail++; console.error(`FAIL: empty input crashed: ${kEmpty}`) }

// ---------------------------------------------------------------------------
// checkNarrationNumbers — guards against LLM-invented numbers
// ---------------------------------------------------------------------------

const classical = {
  cacheKey: 'abc',
  numbers: [100, 65, '+15', '-15', '+40'],
  payload: {},
  sampleSize: 10,
  effectSize: 0.5,
}

// Numbers in allowlist → no violations
const ok1 = checkNarrationNumbers(
  'Heat score 100. Tour requested fired +15. Tour cancelled fired -15.',
  classical,
)
assertEq(ok1.length, 0, 'allowlisted numbers pass')

// Hallucinated number → violation
const bad1 = checkNarrationNumbers(
  'Heat score 100. Conversion dropped 23%.',
  classical,
)
if (bad1.length > 0 && bad1.some((v) => v.token.includes('23'))) pass++
else { fail++; console.error('FAIL: 23% should violate') }

// Year tokens are NOT violations
const ok2 = checkNarrationNumbers(
  'Wedding scheduled for April 2026.',
  classical,
)
assertEq(ok2.length, 0, 'year tokens pass')

// Round percentages tolerated by default
const ok3 = checkNarrationNumbers(
  'Couple is 100% committed to the venue.',
  classical,
)
assertEq(ok3.length, 0, '100% phrase tolerated')

const ok4 = checkNarrationNumbers(
  '50% non-refundable retainer.',
  classical,
)
assertEq(ok4.length, 0, '50% retainer phrase tolerated')

// Round percentage NOT tolerated when option off
const bad2 = checkNarrationNumbers(
  '23% commitment.',
  classical,
  { tolerateRoundPercents: false },
)
if (bad2.length > 0) pass++
else { fail++; console.error('FAIL: 23% should violate even with tolerate flag') }

// Money formatting variations match
const okMoney = checkNarrationNumbers(
  'They asked about the $5,000 retainer.',
  { ...classical, numbers: [5000, ...classical.numbers] },
)
assertEq(okMoney.length, 0, '$5,000 matches 5000 in classical')

// "12 days", "12-day" both reachable from `12`
const okDays = checkNarrationNumbers(
  'Tour 12 days from today.',
  { ...classical, numbers: [12, ...classical.numbers] },
)
assertEq(okDays.length, 0, '"12 days" matches 12 in classical')

// Multiple violations counted
const multi = checkNarrationNumbers(
  'Score 47, dropped 23%, after 9 events.',
  classical,
)
if (multi.length >= 2) pass++
else { fail++; console.error(`FAIL: expected >=2 violations: ${JSON.stringify(multi)}`) }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
