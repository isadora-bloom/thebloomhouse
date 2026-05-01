/**
 * Pure-function tests for the AI provider circuit breaker (T1-F).
 *
 * Verifies:
 *   - Breaker stays untripped under threshold
 *   - Trips at exactly 20% error rate (with min-samples gate)
 *   - Stays tripped for the trip duration window
 *   - getProviderHealth reports current state
 *   - isFallbackForced / isFallbackDisabled read env vars
 *
 * Time-dependent assertions advance Date.now() via a small monkey
 * patch — no fake-timers library, just override + restore.
 *
 * Run with: npx tsx scripts/test-circuit-breaker.ts
 */

import {
  recordCall,
  shouldSkip,
  getProviderHealth,
  isFallbackForced,
  isFallbackDisabled,
  _resetBreaker,
} from '../src/lib/ai/circuit-breaker'

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

// Fake clock — Date.now() override for deterministic time travel.
const realDateNow = Date.now
let mockedNow: number | null = null
Date.now = () => mockedNow ?? realDateNow()
function setNow(ms: number): void { mockedNow = ms }
function restoreNow(): void { mockedNow = null }

try {
  const T0 = 1_000_000_000_000

  // ------------------------------------------------------------
  // 1. Breaker untripped on clean record
  // ------------------------------------------------------------
  _resetBreaker()
  setNow(T0)
  for (let i = 0; i < 10; i++) recordCall('anthropic', true)
  assertEq(shouldSkip('anthropic'), false, 'all-success → breaker stays open')

  // ------------------------------------------------------------
  // 2. Min-samples gate: 1/1 failure does NOT trip (under MIN_SAMPLES)
  // ------------------------------------------------------------
  _resetBreaker()
  setNow(T0)
  recordCall('anthropic', false)
  assertEq(shouldSkip('anthropic'), false, '1/1 failure under MIN_SAMPLES does not trip')

  // ------------------------------------------------------------
  // 3. Trips at >=20% over 5 samples
  // ------------------------------------------------------------
  _resetBreaker()
  setNow(T0)
  // 4 ok + 1 fail = 20% — trips at the threshold
  for (let i = 0; i < 4; i++) recordCall('anthropic', true)
  recordCall('anthropic', false)
  assertEq(shouldSkip('anthropic'), true, '20% error rate trips breaker')

  // ------------------------------------------------------------
  // 4. Tripped state lasts the configured window
  // ------------------------------------------------------------
  setNow(T0 + 30_000) // 30s later
  assertEq(shouldSkip('anthropic'), true, 'still tripped 30s in')
  setNow(T0 + 60_000) // exactly trip duration
  assertEq(shouldSkip('anthropic'), false, 'breaker reopens at trip duration')

  // ------------------------------------------------------------
  // 5. getProviderHealth surfaces state
  // ------------------------------------------------------------
  _resetBreaker()
  setNow(T0)
  for (let i = 0; i < 8; i++) recordCall('openai', true)
  for (let i = 0; i < 2; i++) recordCall('openai', false)
  const health = getProviderHealth('openai')
  assertEq(health.samplesInWindow, 10, 'sample count')
  assertEq(health.errorRate, 0.2, 'error rate computed')
  assertEq(health.tripped, true, 'tripped flag')

  // ------------------------------------------------------------
  // 6. Old events outside the rolling window are pruned
  // ------------------------------------------------------------
  _resetBreaker()
  setNow(T0)
  for (let i = 0; i < 5; i++) recordCall('anthropic', false) // 5/5 fail at T0
  // Move forward past the 5-min window. Any new call should see only
  // its own event in the window.
  setNow(T0 + 6 * 60 * 1000)
  recordCall('anthropic', true)
  const healthAfter = getProviderHealth('anthropic')
  assertEq(healthAfter.samplesInWindow, 1, 'old events pruned')
  assertEq(healthAfter.errorRate, 0, 'fresh window starts clean')

  // ------------------------------------------------------------
  // 7. Env-var overrides
  // ------------------------------------------------------------
  delete process.env.AI_FORCE_FALLBACK
  delete process.env.AI_DISABLE_FALLBACK
  assertEq(isFallbackForced(), false, 'force unset → false')
  assertEq(isFallbackDisabled(), false, 'disable unset → false')
  process.env.AI_FORCE_FALLBACK = 'true'
  assertEq(isFallbackForced(), true, 'force=true → true')
  process.env.AI_FORCE_FALLBACK = '1'
  assertEq(isFallbackForced(), true, 'force=1 → true')
  process.env.AI_FORCE_FALLBACK = 'yes'
  assertEq(isFallbackForced(), false, 'force=yes → false (only true/1 accepted)')
  process.env.AI_DISABLE_FALLBACK = 'true'
  assertEq(isFallbackDisabled(), true, 'disable=true → true')
  delete process.env.AI_FORCE_FALLBACK
  delete process.env.AI_DISABLE_FALLBACK

} finally {
  restoreNow()
  Date.now = realDateNow
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
