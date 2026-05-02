/**
 * Unit tests — observability metrics helpers (OPS-21.2.3).
 *
 * Targets the pure helper (classifyError); the DB-writing functions
 * (recordCounter, recordHistogram, trackCronRun) are integration-
 * tested via the live cron path and the pipeline-health page.
 */

import { __test__ } from '../src/lib/observability/metrics'

const { classifyError } = __test__

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

console.log('\n=== classifyError ===')
assert(classifyError(null) === 'unknown', 'null → unknown')
assert(classifyError(undefined) === 'unknown', 'undefined → unknown')
assert(classifyError(new Error('Request timed out')) === 'timeout', 'timed out → timeout')
assert(classifyError(new Error('connection timeout')) === 'timeout', 'timeout → timeout')
assert(classifyError(new Error('429 Too Many Requests')) === 'rate_limit', '429 → rate_limit')
assert(classifyError(new Error('Rate limit exceeded')) === 'rate_limit', 'rate limit text → rate_limit')
assert(classifyError(new Error('Throttled by upstream')) === 'rate_limit', 'throttled → rate_limit')
assert(classifyError(new Error('401 Unauthorized')) === 'auth', '401 → auth')
assert(classifyError(new Error('403 Forbidden')) === 'auth', '403 → auth')
assert(classifyError(new Error('Resource not found')) === 'not_found', 'not found → not_found')
assert(classifyError(new Error('ECONNREFUSED 127.0.0.1:5432')) === 'network', 'ECONNREFUSED → network')
assert(classifyError(new Error('Network unreachable')) === 'network', 'network → network')
assert(classifyError(new Error('Some weird DB error')) === 'unknown', 'unrecognised → unknown')
assert(classifyError('plain string error') === 'unknown', 'string-only error → unknown')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
