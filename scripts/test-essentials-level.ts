/**
 * Unit tests — Essentials slider helper (T4-D).
 *
 * Pure function: given an item's visibility class + the current
 * level, decide whether to render. The hook + slider component
 * (use-essentials-level.ts, essentials-slider.tsx) are React/DOM-
 * dependent and not unit-tested here.
 */

import { shouldShowAtLevel } from '../src/lib/hooks/use-essentials-level'

let pass = 0
let fail = 0
function assert(cond: unknown, label: string) {
  if (cond) { console.log(`  ✓ ${label}`); pass++ }
  else { console.error(`  ✗ ${label}`); fail++ }
}

console.log('\n=== shouldShowAtLevel ===')

// At 'essentials' level, only essential items render.
assert(shouldShowAtLevel('essential', 'essentials'), 'essential item shown at essentials')
assert(!shouldShowAtLevel('recommended', 'essentials'), 'recommended item HIDDEN at essentials')
assert(!shouldShowAtLevel('expanded', 'essentials'), 'expanded item HIDDEN at essentials')
assert(!shouldShowAtLevel('everything', 'essentials'), 'everything item HIDDEN at essentials')

// At 'recommended' level, essentials + recommended render.
assert(shouldShowAtLevel('essential', 'recommended'), 'essential shown at recommended')
assert(shouldShowAtLevel('recommended', 'recommended'), 'recommended shown at recommended')
assert(!shouldShowAtLevel('expanded', 'recommended'), 'expanded HIDDEN at recommended')
assert(!shouldShowAtLevel('everything', 'recommended'), 'everything HIDDEN at recommended')

// At 'expanded' level, three lower tiers render.
assert(shouldShowAtLevel('essential', 'expanded'), 'essential shown at expanded')
assert(shouldShowAtLevel('recommended', 'expanded'), 'recommended shown at expanded')
assert(shouldShowAtLevel('expanded', 'expanded'), 'expanded shown at expanded')
assert(!shouldShowAtLevel('everything', 'expanded'), 'everything HIDDEN at expanded')

// At 'everything' level, all four tiers render.
assert(shouldShowAtLevel('essential', 'everything'), 'essential shown at everything')
assert(shouldShowAtLevel('recommended', 'everything'), 'recommended shown at everything')
assert(shouldShowAtLevel('expanded', 'everything'), 'expanded shown at everything')
assert(shouldShowAtLevel('everything', 'everything'), 'everything shown at everything')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
