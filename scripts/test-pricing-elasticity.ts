/**
 * Unit tests — pricing-elasticity classifier (T3-F INS-19.5.2).
 *
 * Targets the bandaid traps the design wanted to avoid:
 *   - Confound override (marketing spend or adjacent change → forced
 *     to 'inconclusive' regardless of elasticity sign)
 *   - Sample-size guard (pre_n or post_n < 8 → inconclusive)
 *   - Null elasticity → inconclusive (zero-division upstream)
 *   - Sign-aware classification (positive elasticity = premium signal,
 *     not "elastic")
 *   - Magnitude bands match the spec
 */

import { __test__ } from '../src/lib/services/insights/pricing-elasticity'

const { classifyElasticity, MIN_PER_WINDOW_RESOLVED } = __test__

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

const cleanArgs = {
  has_adjacent_change: false,
  marketing_confound: false,
  pre_n: 20,
  post_n: 20,
}

console.log('\n=== Hard guards force "inconclusive" ===')
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -1.5, has_adjacent_change: true })
  === 'inconclusive',
  'adjacent price change in window → inconclusive (overrides strong elastic signal)',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -1.5, marketing_confound: true })
  === 'inconclusive',
  'marketing-spend confound → inconclusive (overrides strong elastic signal)',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: null })
  === 'inconclusive',
  'null elasticity (zero-division upstream) → inconclusive',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -1.5, pre_n: 5 })
  === 'inconclusive',
  `pre_n < ${MIN_PER_WINDOW_RESOLVED} → inconclusive`,
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -1.5, post_n: 7 })
  === 'inconclusive',
  `post_n < ${MIN_PER_WINDOW_RESOLVED} → inconclusive`,
)

console.log('\n=== Magnitude bands (no confounds) ===')
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -1.5 }) === 'elastic',
  '|elasticity| >= 1.0 → elastic',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -2.0 }) === 'elastic',
  '|elasticity| = 2.0 → elastic',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -1.0 }) === 'elastic',
  '|elasticity| = 1.0 (boundary) → elastic',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -0.3 }) === 'inelastic',
  '|elasticity| = 0.3 → inelastic',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -0.49 }) === 'inelastic',
  '|elasticity| = 0.49 (boundary just-below) → inelastic',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: 0 }) === 'inelastic',
  'zero elasticity → inelastic',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: -0.7 }) === 'inelastic',
  'mild negative (-0.7) → inelastic (between bands)',
)

console.log('\n=== Positive elasticity = premium signal ===')
assert(
  classifyElasticity({ ...cleanArgs, elasticity: 0.5 }) === 'positive',
  'positive elasticity → "positive" (premium positioning OR confound)',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: 2.0 }) === 'positive',
  'large positive → still "positive" (NOT "elastic")',
)
assert(
  classifyElasticity({ ...cleanArgs, elasticity: 0.05 }) === 'inelastic',
  'tiny positive (< 0.1) → inelastic (below positive threshold)',
)

console.log('\n=== Belt + suspenders: confound + positive elasticity ===')
{
  const res = classifyElasticity({
    ...cleanArgs,
    elasticity: 1.5,
    marketing_confound: true,
  })
  assert(res === 'inconclusive', 'positive elasticity + marketing confound → inconclusive (not "positive")')
}
{
  // Edge: at the elastic boundary with adjacent change → inconclusive.
  const res = classifyElasticity({
    ...cleanArgs,
    elasticity: -1.0,
    has_adjacent_change: true,
  })
  assert(res === 'inconclusive', 'boundary elastic + adjacent change → inconclusive')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
