/**
 * Pure-function tests for the structured logger (T1-G).
 *
 * Verifies:
 *   - createLogger emits one JSON line per call
 *   - Required schema fields present (level, msg, venue_id,
 *     correlation_id, actor, ts)
 *   - PII redaction wraps msg + data
 *   - child loggers inherit + override context
 *   - Levels route to console.log / .warn / .error
 *
 * Run with: npx tsx scripts/test-logger.ts
 */

import { createLogger, logEvent, newCorrelationId } from '../src/lib/observability/logger'

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

function assertContains(actual: string, needle: string, label: string): void {
  if (actual.includes(needle)) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${label}\n  expected to contain: ${needle}\n  actual:              ${actual}`)
  }
}

// Capture console output. The logger writes one JSON line per call.
type Captured = { stream: 'log' | 'warn' | 'error'; line: string }
const captured: Captured[] = []
const realLog = console.log
const realWarn = console.warn
const realError = console.error
console.log = (...args: unknown[]) => { captured.push({ stream: 'log', line: String(args[0]) }) }
console.warn = (...args: unknown[]) => { captured.push({ stream: 'warn', line: String(args[0]) }) }
console.error = (...args: unknown[]) => { captured.push({ stream: 'error', line: String(args[0]) }) }

try {
  // ------------------------------------------------------------
  // 1. Required schema fields
  // ------------------------------------------------------------
  const log = createLogger({
    venueId: '22222222-2222-2222-2222-222222222201',
    correlationId: 'corr-1',
    actor: 'gmail_pull',
  })
  log.info('email.classified', {
    event_type: 'email_pipeline.classify',
    outcome: 'ok',
    latency_ms: 42,
    data: { classification: 'new_inquiry' },
  })

  assertEq(captured.length, 1, 'one line per call')
  const parsed = JSON.parse(captured[0].line)
  assertEq(parsed.level, 'info', 'level recorded')
  assertEq(parsed.msg, 'email.classified', 'msg recorded')
  assertEq(parsed.venue_id, '22222222-2222-2222-2222-222222222201', 'venue_id from context')
  assertEq(parsed.correlation_id, 'corr-1', 'correlation_id from context')
  assertEq(parsed.actor, 'gmail_pull', 'actor from context')
  assertEq(parsed.event_type, 'email_pipeline.classify', 'event_type passed through')
  assertEq(parsed.outcome, 'ok', 'outcome passed through')
  assertEq(parsed.latency_ms, 42, 'latency_ms passed through')
  assertEq(parsed.data.classification, 'new_inquiry', 'data payload passed through')
  if (typeof parsed.ts === 'string' && parsed.ts.length > 0) pass++
  else { fail++; realError.call(console, 'FAIL: ts stamped') }

  // ------------------------------------------------------------
  // 2. Levels route to correct stream
  // ------------------------------------------------------------
  captured.length = 0
  log.warn('something.suspicious')
  log.error('something.broken')
  log.debug('something.verbose')
  assertEq(captured[0].stream, 'warn', 'warn → console.warn')
  assertEq(captured[1].stream, 'error', 'error → console.error')
  assertEq(captured[2].stream, 'log', 'debug → console.log')

  // ------------------------------------------------------------
  // 3. PII redaction on msg + data
  // ------------------------------------------------------------
  captured.length = 0
  log.info('contact madison@gmail.com about the tour', {
    data: { phone: '555-123-4567', note: 'call her at 555-123-4567 tomorrow' },
  })
  const piiLine = captured[0].line
  // Email + phone shapes should be scrubbed by redactObject.
  if (!piiLine.includes('madison@gmail.com')) pass++
  else { fail++; realError.call(console, 'FAIL: email not redacted from msg') }
  if (!piiLine.includes('555-123-4567')) pass++
  else { fail++; realError.call(console, 'FAIL: phone not redacted from data') }

  // ------------------------------------------------------------
  // 4. Child logger inherits + overrides
  // ------------------------------------------------------------
  captured.length = 0
  const child = log.child({ correlationId: 'corr-2' })
  child.info('child.event')
  const childParsed = JSON.parse(captured[0].line)
  assertEq(childParsed.venue_id, '22222222-2222-2222-2222-222222222201', 'child inherits venue_id')
  assertEq(childParsed.correlation_id, 'corr-2', 'child overrides correlation_id')
  assertEq(childParsed.actor, 'gmail_pull', 'child inherits actor')

  // ------------------------------------------------------------
  // 5. Logger props expose context
  // ------------------------------------------------------------
  assertEq(log.correlationId, 'corr-1', 'logger exposes correlation_id')
  assertEq(log.venueId, '22222222-2222-2222-2222-222222222201', 'logger exposes venue_id')

  // ------------------------------------------------------------
  // 6. logEvent one-off
  // ------------------------------------------------------------
  captured.length = 0
  logEvent({
    level: 'warn',
    msg: 'cron.skipped',
    venueId: 'v1',
    actor: 'cron:cost_ceiling_check',
    event_type: 'cron.cost_ceiling',
    outcome: 'skip',
  })
  const cronParsed = JSON.parse(captured[0].line)
  assertEq(cronParsed.actor, 'cron:cost_ceiling_check', 'logEvent threads actor')
  assertEq(cronParsed.outcome, 'skip', 'logEvent threads outcome')

  // ------------------------------------------------------------
  // 7. newCorrelationId returns a uuid-shaped string
  // ------------------------------------------------------------
  const cid = newCorrelationId()
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(cid)) pass++
  else { fail++; realError.call(console, `FAIL: newCorrelationId not uuid: ${cid}`) }

} finally {
  console.log = realLog
  console.warn = realWarn
  console.error = realError
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
