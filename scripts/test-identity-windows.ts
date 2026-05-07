/**
 * Pure-function tests for identity-windows (T2-D / ARCH-8.5.3).
 *
 * Verifies:
 *   - DEFAULT_PER_PLATFORM_WINDOWS shape & values match the spec
 *   - windowsForPlatform fallback chain (exact → lowercase → default
 *     → hard-coded floor)
 *   - Per-platform windows differ from each other (Knot vs GMB)
 *
 * loadPerPlatformWindows / savePerPlatformWindows are integration
 * concerns that need a live Supabase + venue_config row; cover those
 * in the e2e suite if needed.
 *
 * Run with: npx tsx scripts/test-identity-windows.ts
 */

import {
  DEFAULT_PER_PLATFORM_WINDOWS,
  windowsForPlatform,
  type PerPlatformWindow,
  type PerPlatformWindowMap,
} from '../src/lib/services/identity/windows'

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

// ------------------------------------------------------------
// 1. Defaults match the spec
// ------------------------------------------------------------
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.knot.tier_2_days, 365, 'knot tier_2_days = 365 (year of bridal lead time)')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.the_knot.tier_2_days, 365, 'the_knot alias matches knot')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.weddingwire.tier_2_days, 365, 'weddingwire = 365')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.zola.tier_2_days, 365, 'zola = 365')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.pinterest.tier_2_days, 540, 'pinterest = 540 (~18mo)')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.instagram.tier_2_days, 180, 'instagram = 180 (~6mo)')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.facebook.tier_2_days, 180, 'facebook = 180')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.google_business.tier_1_hours, 168, 'GMB tier_1_hours = 168 (1 week)')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.google_business.tier_2_days, 30, 'GMB tier_2_days = 30')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.default.tier_1_hours, 72, 'default tier_1_hours = 72 (pre-T2-D constant)')
assertEq(DEFAULT_PER_PLATFORM_WINDOWS.default.tier_2_days, 30, 'default tier_2_days = 30 (pre-T2-D constant)')

// ------------------------------------------------------------
// 2. windowsForPlatform fallback chain
// ------------------------------------------------------------
const map: PerPlatformWindowMap = {
  knot:    { tier_1_hours: 100, tier_2_days: 200 },
  default: { tier_1_hours: 50,  tier_2_days: 25 },
}

assertEq(windowsForPlatform(map, 'knot'), { tier_1_hours: 100, tier_2_days: 200 }, 'exact match returns platform row')
assertEq(windowsForPlatform(map, 'KNOT'), { tier_1_hours: 100, tier_2_days: 200 }, 'mixed case falls through lowercase')
assertEq(windowsForPlatform(map, 'unknown_platform'), { tier_1_hours: 50, tier_2_days: 25 }, 'unknown platform → default bucket')
assertEq(windowsForPlatform(map, null), { tier_1_hours: 50, tier_2_days: 25 }, 'null platform → default')
assertEq(windowsForPlatform(map, undefined), { tier_1_hours: 50, tier_2_days: 25 }, 'undefined platform → default')
assertEq(windowsForPlatform(map, ''), { tier_1_hours: 50, tier_2_days: 25 }, 'empty string → default')

// Map without 'default' key → hard-coded floor
const noDefault: PerPlatformWindowMap = {
  knot: { tier_1_hours: 100, tier_2_days: 200 },
}
assertEq(
  windowsForPlatform(noDefault, 'unknown'),
  { tier_1_hours: 72, tier_2_days: 30 },
  'no default key → hard-coded floor (72/30)',
)

// ------------------------------------------------------------
// 3. Per-platform windows ARE different (proves T2-D actually changes
//    behaviour vs the pre-fix global constants)
// ------------------------------------------------------------
const knot = DEFAULT_PER_PLATFORM_WINDOWS.knot
const gmb = DEFAULT_PER_PLATFORM_WINDOWS.google_business
if (knot.tier_2_days !== gmb.tier_2_days) pass++
else { fail++; console.error('FAIL: Knot and GMB tier_2_days should differ') }
if (knot.tier_1_hours !== gmb.tier_1_hours) pass++
else { fail++; console.error('FAIL: Knot and GMB tier_1_hours should differ') }

// Knot at Tier 2 should be much larger than the pre-T2-D global (30d)
// — that's the whole point of the fix.
if (knot.tier_2_days > 30) pass++
else { fail++; console.error('FAIL: Knot tier_2_days must exceed pre-T2-D 30d global') }

// GMB at Tier 1 should be larger than the pre-T2-D global (72h) but
// smaller than its tier_2 in days*24.
if (gmb.tier_1_hours > 72 && gmb.tier_1_hours < gmb.tier_2_days * 24) pass++
else { fail++; console.error('FAIL: GMB Tier 1 should be > 72h and < Tier 2') }

// ------------------------------------------------------------
// 4. Type sanity — every entry has both fields
// ------------------------------------------------------------
for (const [platform, w] of Object.entries(DEFAULT_PER_PLATFORM_WINDOWS)) {
  if (typeof w.tier_1_hours === 'number' && typeof w.tier_2_days === 'number') pass++
  else { fail++; console.error(`FAIL: ${platform} missing fields`) }
  // Sanity: Tier 1 should not exceed Tier 2 (would never reach Tier 1)
  if (w.tier_1_hours <= w.tier_2_days * 24) pass++
  else {
    fail++
    console.error(`FAIL: ${platform} Tier 1 ${w.tier_1_hours}h > Tier 2 ${w.tier_2_days * 24}h`)
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
