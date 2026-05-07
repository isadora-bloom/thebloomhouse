/**
 * Unit tests — pulse-aggregator pure helpers (ARCH-20.2.2).
 */

import { __test__ } from '../src/lib/services/intel/pulse-aggregator'

const { notificationPriority, anomalyPriority, PRIORITY_RANK, dedupeAndLimit } = __test__

let pass = 0
let fail = 0

function assert(cond: unknown, label: string) {
  if (cond) { console.log(`  ✓ ${label}`); pass++ }
  else { console.error(`  ✗ ${label}`); fail++ }
}

console.log('\n=== notificationPriority ===')
assert(notificationPriority('escalation') === 'critical', 'escalation → critical')
assert(notificationPriority('brain_dump_kb_import_confirm') === 'high', 'brain-dump confirm → high')
assert(notificationPriority('auto_send_pending') === 'high', 'auto_send_pending → high')
assert(notificationPriority('sage_uncertain') === 'high', 'sage_uncertain → high')
assert(notificationPriority('cron_failed') === 'medium', 'unknown type → medium (default)')

console.log('\n=== anomalyPriority ===')
assert(anomalyPriority('critical') === 'critical', 'critical severity → critical')
assert(anomalyPriority('warning') === 'high', 'warning severity → high')
assert(anomalyPriority('info') === 'low', 'info severity → low')

console.log('\n=== PRIORITY_RANK ordering ===')
assert(PRIORITY_RANK.critical < PRIORITY_RANK.high, 'critical sorts before high')
assert(PRIORITY_RANK.high < PRIORITY_RANK.medium, 'high sorts before medium')
assert(PRIORITY_RANK.medium < PRIORITY_RANK.low, 'medium sorts before low')

console.log('\n=== dedupeAndLimit ===')
assert(dedupeAndLimit([], 10).length === 0, 'empty input → empty')
{
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'c' }]
  const out = dedupeAndLimit(items, 10)
  assert(out.length === 3, 'duplicates removed')
  assert(out.map((x) => x.id).join(',') === 'a,b,c', 'order preserved (first wins)')
}
{
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]
  const out = dedupeAndLimit(items, 3)
  assert(out.length === 3, 'limit honoured')
  assert(out[2].id === 'c', 'first N kept')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
