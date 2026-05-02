/**
 * Unit tests — digest preferences pure helpers (T4-H).
 */

import { __test__ } from '../src/lib/services/digest-preferences'

const { shouldSendToday, enabledCategories, DEFAULT_PREFS } = __test__

let pass = 0
let fail = 0
function assert(cond: unknown, label: string) {
  if (cond) { console.log(`  ✓ ${label}`); pass++ }
  else { console.error(`  ✗ ${label}`); fail++ }
}

const NOW = new Date('2026-05-04T07:00:00Z')  // Monday 07:00 UTC
const MONDAY = 1, TUESDAY = 2

function isoMinus(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString()
}

console.log('\n=== shouldSendToday — cadence=off ===')
assert(!shouldSendToday({ cadence: 'off', send_dow: 1, last_sent_at: null }, MONDAY, NOW), 'off → never')

console.log('\n=== shouldSendToday — daily ===')
assert(shouldSendToday({ cadence: 'daily', send_dow: 1, last_sent_at: null }, MONDAY, NOW), 'daily + never sent → yes')
assert(!shouldSendToday({ cadence: 'daily', send_dow: 1, last_sent_at: isoMinus(0.5) }, MONDAY, NOW), 'daily + sent 12h ago → no')
assert(shouldSendToday({ cadence: 'daily', send_dow: 1, last_sent_at: isoMinus(1) }, MONDAY, NOW), 'daily + sent 24h ago → yes')

console.log('\n=== shouldSendToday — weekly ===')
assert(shouldSendToday({ cadence: 'weekly', send_dow: 1, last_sent_at: null }, MONDAY, NOW), 'weekly + Mon + never sent → yes')
assert(!shouldSendToday({ cadence: 'weekly', send_dow: 1, last_sent_at: null }, TUESDAY, NOW), 'weekly + Tue (mismatch) → no')
assert(!shouldSendToday({ cadence: 'weekly', send_dow: 1, last_sent_at: isoMinus(3) }, MONDAY, NOW), 'weekly + Mon + sent 3d ago → no')
assert(shouldSendToday({ cadence: 'weekly', send_dow: 1, last_sent_at: isoMinus(7) }, MONDAY, NOW), 'weekly + Mon + sent 7d ago → yes')

console.log('\n=== shouldSendToday — biweekly ===')
assert(shouldSendToday({ cadence: 'biweekly', send_dow: 1, last_sent_at: isoMinus(14) }, MONDAY, NOW), 'biweekly + Mon + 14d → yes')
assert(!shouldSendToday({ cadence: 'biweekly', send_dow: 1, last_sent_at: isoMinus(7) }, MONDAY, NOW), 'biweekly + Mon + 7d → no')

console.log('\n=== enabledCategories ===')
{
  const cats = enabledCategories({
    id: 'x', user_id: 'u', venue_id: 'v',
    last_sent_at: null,
    ...DEFAULT_PREFS,
  })
  assert(cats.has('lead_conversion'), 'default includes lead_conversion')
  assert(cats.has('pricing'), 'default includes pricing')
  assert(cats.has('source_attribution'), 'default includes source_attribution')
  assert(cats.has('anomaly'), 'default includes anomaly (from include_anomalies)')
  assert(cats.has('correlation'), 'default includes correlation (from macro)')
  assert(!cats.has('agent_quality'), 'default EXCLUDES agent_quality (self-knowledge opt-in)')
  assert(!cats.has('venue_strategy'), 'default EXCLUDES venue_strategy (self-knowledge opt-in)')
}
{
  const cats = enabledCategories({
    id: 'x', user_id: 'u', venue_id: 'v',
    last_sent_at: null,
    ...DEFAULT_PREFS,
    include_self_knowledge: true,
  })
  assert(cats.has('agent_quality'), 'opt-in self-knowledge → adds agent_quality')
  assert(cats.has('venue_strategy'), 'opt-in self-knowledge → adds venue_strategy')
}
{
  const cats = enabledCategories({
    id: 'x', user_id: 'u', venue_id: 'v',
    last_sent_at: null,
    ...DEFAULT_PREFS,
    include_anomalies: false,
    include_macro_correlations: false,
  })
  assert(!cats.has('anomaly'), 'opt-out anomalies → excludes anomaly')
  assert(!cats.has('correlation'), 'opt-out macro → excludes correlation')
  assert(!cats.has('weather'), 'opt-out macro → excludes weather')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
