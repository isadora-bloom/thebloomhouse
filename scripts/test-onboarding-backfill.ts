/**
 * Unit tests — onboarding backfill pure helpers
 * (ARCH-18.2 / 18.3-C / 18.3-D / LIMB-16.3).
 *
 * Targets:
 *   - computeStatus classifies (rowCount, oldest, newest) into the
 *     right status; honours coordinator-skipped marker
 *   - scoreCoverage weights required vs optional categories correctly;
 *     bonus for optional doesn't push score above 100
 *   - Empty / degenerate inputs return safe defaults
 */

import { __test__ } from '../src/lib/services/onboarding/backfill'
import type { CategoryCoverage, BackfillCategory } from '../src/lib/services/onboarding/backfill'

const { computeStatus, scoreCoverage, CATEGORY_REQUIRED } = __test__

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

function dateOffset(daysAgo: number): Date {
  return new Date(Date.now() - daysAgo * 86_400_000)
}

console.log('\n=== computeStatus ===')
{
  // Zero rows → not_started.
  const r = computeStatus({ rowCount: 0, oldest: null, newest: null })
  assert(r.status === 'not_started', 'rowCount=0 → not_started')
  assert(r.coverage_days === 0, 'coverage_days=0 when not_started')
}
{
  // Coordinator-skipped wins over any other state.
  const r = computeStatus({ rowCount: 100, oldest: dateOffset(500), newest: new Date(), isSkipped: true })
  assert(r.status === 'skipped', 'isSkipped=true → skipped (overrides full coverage)')
  assert(r.coverage_days === 0, 'skipped reports coverage_days=0')
}
{
  // 12 months exactly → complete.
  const r = computeStatus({ rowCount: 365, oldest: dateOffset(365), newest: new Date() })
  assert(r.status === 'complete', '365 days coverage → complete')
  assert(r.coverage_days >= 364 && r.coverage_days <= 366, 'coverage_days ~ 365 (clock-precision tolerant)')
}
{
  // 6 months → partial.
  const r = computeStatus({ rowCount: 180, oldest: dateOffset(180), newest: new Date() })
  assert(r.status === 'partial', '180 days coverage → partial')
  assert(r.coverage_days >= 179 && r.coverage_days <= 181, 'coverage_days ~ 180')
}
{
  // > 12 months → still complete (not over-categorised).
  const r = computeStatus({ rowCount: 1000, oldest: dateOffset(1000), newest: new Date() })
  assert(r.status === 'complete', '1000 days → still complete')
}
{
  // rowCount > 0 but null dates (data shape we never expect, but the
  // helper must not throw) → not_started.
  const r = computeStatus({ rowCount: 5, oldest: null, newest: null })
  assert(r.status === 'not_started', 'rowCount > 0 + null dates → not_started (safe degenerate handling)')
}

console.log('\n=== scoreCoverage ===')

// Build a base set of required-only coverages all at not_started.
function makeCoverage(category: BackfillCategory, status: 'not_started' | 'partial' | 'complete' | 'skipped'): CategoryCoverage {
  return { category, status, oldest_at: null, newest_at: null, row_count: 0, coverage_days: 0, hint: '' }
}

const requiredCats = (Object.keys(CATEGORY_REQUIRED) as BackfillCategory[]).filter((k) => CATEGORY_REQUIRED[k])
const optionalCats = (Object.keys(CATEGORY_REQUIRED) as BackfillCategory[]).filter((k) => !CATEGORY_REQUIRED[k])

assert(requiredCats.length > 0, 'at least one required category exists')
assert(optionalCats.length > 0, 'at least one optional category exists')

{
  const all = [...requiredCats.map((c) => makeCoverage(c, 'not_started')), ...optionalCats.map((c) => makeCoverage(c, 'not_started'))]
  assert(scoreCoverage(all) === 0, 'all not_started → score 0')
}

{
  const all = [...requiredCats.map((c) => makeCoverage(c, 'complete')), ...optionalCats.map((c) => makeCoverage(c, 'not_started'))]
  assert(scoreCoverage(all) === 100, 'all required complete + optional not_started → score 100')
}

{
  const all = [
    ...requiredCats.map((c) => makeCoverage(c, 'complete')),
    ...optionalCats.map((c) => makeCoverage(c, 'complete')),
  ]
  assert(scoreCoverage(all) === 100, 'all required + all optional complete → capped at 100 (no >100)')
}

{
  // Half required complete.
  const half = Math.ceil(requiredCats.length / 2)
  const all = [
    ...requiredCats.slice(0, half).map((c) => makeCoverage(c, 'complete')),
    ...requiredCats.slice(half).map((c) => makeCoverage(c, 'not_started')),
  ]
  const expected = Math.round((half / requiredCats.length) * 100)
  assert(scoreCoverage(all) === expected, `${half}/${requiredCats.length} required complete → score ${expected}`)
}

{
  // Skipped counts as complete.
  const all = requiredCats.map((c, i) => makeCoverage(c, i === 0 ? 'skipped' : 'complete'))
  assert(scoreCoverage(all) === 100, 'one required skipped, rest complete → score 100')
}

{
  // Partial doesn't count as complete.
  const all = requiredCats.map((c) => makeCoverage(c, 'partial'))
  assert(scoreCoverage(all) === 0, 'all required partial → score 0 (partial doesn\'t earn)')
}

{
  // Empty input → 0 (avoid div/0).
  assert(scoreCoverage([]) === 0, 'empty coverages → score 0 (no div/0)')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
