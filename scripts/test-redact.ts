/**
 * Unit tests for src/lib/observability/redact.ts
 *
 * Pure-function tests — same pattern as scripts/test-normalize-source.ts.
 * Run with: npx tsx scripts/test-redact.ts
 *
 * Wired into CI via .github/workflows/ci.yml alongside the other
 * pure-function tests. Per OPS-21.1.1-A this is the surgical-test
 * pattern that fits the repo until a full vitest harness lands.
 */

import { redact, redactError, redactObject } from '../src/lib/observability/redact'

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

function assertContains(actual: string, expected: string, label: string): void {
  if (actual.includes(expected)) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${label}\n  expected to contain: ${expected}\n  actual:              ${actual}`)
  }
}

function assertNotContains(actual: string, forbidden: string, label: string): void {
  if (!actual.includes(forbidden)) {
    pass++
  } else {
    fail++
    console.error(`FAIL: ${label}\n  expected NOT to contain: ${forbidden}\n  actual:                  ${actual}`)
  }
}

// =============================================================
// Email redaction
// =============================================================

assertEq(
  redact('user @ contact: alice@example.com replied'),
  'user @ contact: [REDACTED_EMAIL] replied',
  'email basic',
)
assertEq(
  redact('From: Bob.Smith+filter@sub.example.co.uk'),
  'From: [REDACTED_EMAIL]',
  'email with subdomain + plus tag',
)
assertEq(
  redact('multiple: a@b.com and c@d.org'),
  'multiple: [REDACTED_EMAIL] and [REDACTED_EMAIL]',
  'email multiple',
)
assertEq(
  redact('not an email: just@text without dot'),
  'not an email: just@text without dot',
  'email needs TLD',
)

// =============================================================
// Phone redaction — must catch real phones, miss common false positives
// =============================================================

assertEq(
  redact('Call (555) 123-4567 today'),
  'Call [REDACTED_PHONE] today',
  'phone with parens',
)
assertEq(
  redact('Phone: 555-123-4567'),
  'Phone: [REDACTED_PHONE]',
  'phone with dashes',
)
assertEq(
  redact('Phone: 555.123.4567'),
  'Phone: [REDACTED_PHONE]',
  'phone with dots',
)
assertEq(
  redact('Intl: +1 555-123-4567'),
  'Intl: [REDACTED_PHONE]',
  'phone with country code',
)

// FALSE-POSITIVE checks: things that LOOK like phones but aren't
assertNotContains(
  redact('Order INV-2024-0001-2345'),
  '[REDACTED_PHONE]',
  'order ID with dashes should NOT redact',
)
assertNotContains(
  redact('UUID 550e8400-e29b-41d4-a716-446655440000'),
  '[REDACTED_PHONE]',
  'UUID should NOT redact (mixed alpha)',
)
assertNotContains(
  redact('Timestamp 2026-05-01-1234'),
  '[REDACTED_PHONE]',
  'timestamp should NOT redact',
)
assertNotContains(
  redact('Error code 404 not found'),
  '[REDACTED_PHONE]',
  '3-digit code alone should NOT redact',
)
// Plain 10-digit run: this CAN false-positive but the playbook
// trade-off accepts that — explicit dash separators are the canonical
// phone shape.
assertEq(
  redact('Bare digits 5551234567 in the middle'),
  'Bare digits 5551234567 in the middle',
  'plain digit run without separators NOT matched (tightened regex)',
)

// =============================================================
// Credit card redaction
// =============================================================

assertEq(
  redact('Card 4111-1111-1111-1111 expired'),
  'Card [REDACTED_CC] expired',
  'CC with dashes',
)
assertEq(
  redact('Card 4111 1111 1111 1111'),
  'Card [REDACTED_CC]',
  'CC with spaces',
)
assertNotContains(
  redact('UUID 550e8400-e29b-41d4-a716-446655440000'),
  '[REDACTED_CC]',
  'UUID should NOT redact as CC',
)

// =============================================================
// Long quoted strings (transcript content proxy)
// =============================================================

assertContains(
  redact('Error from Anthropic: input length exceeded: "I want to say a few words about my late father, who passed last year, and about how this venue brings together everything our family loves about coming together for joy"'),
  '[REDACTED_QUOTE_80CHAR+]',
  'long quoted string redacted',
)
assertEq(
  redact('Got short string: "approved" back'),
  'Got short string: "approved" back',
  'short quoted strings NOT redacted',
)
assertEq(
  redact('JSON-ish: "status_pending_approval_with_review"'),
  'JSON-ish: "status_pending_approval_with_review"',
  '37-char quoted string NOT redacted (under 80 threshold)',
)

// =============================================================
// redactError — convenience for catch blocks
// =============================================================

const errWithEmail = new Error('failed for user alice@example.com on retry')
assertEq(
  redactError(errWithEmail),
  'failed for user [REDACTED_EMAIL] on retry',
  'redactError on Error instance',
)
assertEq(
  redactError('plain string with phone 555-123-4567'),
  'plain string with phone [REDACTED_PHONE]',
  'redactError on plain string',
)
assertEq(
  redactError(null),
  'null',
  'redactError on null',
)

// =============================================================
// redactObject — recursive on string leaves
// =============================================================

assertEq(
  redactObject({ name: 'alice@example.com', code: 200 }),
  { name: '[REDACTED_EMAIL]', code: 200 },
  'redactObject string leaf',
)
assertEq(
  redactObject({
    user: { email: 'bob@example.com' },
    meta: { count: 5 },
  }),
  {
    user: { email: '[REDACTED_EMAIL]' },
    meta: { count: 5 },
  },
  'redactObject nested',
)

// =============================================================
// Composition — multiple shapes in one string
// =============================================================

const composite =
  'Customer alice@example.com called from 555-123-4567 about card 4111-1111-1111-1111'
assertEq(
  redact(composite),
  'Customer [REDACTED_EMAIL] called from [REDACTED_PHONE] about card [REDACTED_CC]',
  'composite redaction',
)

// =============================================================
// Empty / null safety
// =============================================================

assertEq(redact(''), '', 'empty string')
// redact takes string; null/undefined would TS-fail. Test convenience:
assertEq(redact('no PII here'), 'no PII here', 'no-PII passthrough')

// =============================================================
// Summary
// =============================================================

console.log(`\nredact tests: ${pass} pass / ${fail} fail`)
if (fail > 0) {
  process.exit(1)
}
