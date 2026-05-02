/**
 * Unit tests — sanitizeFrictionTag (T3 review P1 #8 / risk-flags PII).
 *
 * Coordinators occasionally type free-text friction tags that
 * accidentally include couple PII ("jane@example.com complained" or
 * "called 555-123-4567"). These tags get persisted into
 * intelligence_insights.evidence + data_points jsonb, which surfaces
 * in /intel UIs. The sanitiser strips emails + phone numbers before
 * persistence.
 */

import { sanitizeFrictionTag } from '../src/lib/services/insights/risk-flags'

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

console.log('\n=== sanitizeFrictionTag ===')

// Pass-through for clean enum-like tags.
assert(sanitizeFrictionTag('payment_late') === 'payment_late', 'enum tag passes through')
assert(sanitizeFrictionTag('honeybook_refund_received') === 'honeybook_refund_received', 'long enum tag passes through')

// Email redaction
assert(
  sanitizeFrictionTag('jane@example.com complained') === '[redacted-email] complained',
  'email redacted',
)
assert(
  sanitizeFrictionTag('email: bride+wedding@gmail.co.uk') === 'email: [redacted-email]',
  'email with plus-tag and country TLD redacted',
)

// Phone redaction — common formats
assert(
  sanitizeFrictionTag('called 555-123-4567 about deposit') === 'called [redacted-phone] about deposit',
  'dashed phone redacted',
)
assert(
  sanitizeFrictionTag('phone (555) 123 4567') === 'phone [redacted-phone]',
  'parenthesised phone redacted',
)
assert(
  sanitizeFrictionTag('+1 555.123.4567 left voicemail') === '[redacted-phone] left voicemail',
  'phone with country code + dots redacted',
)

// Both PII forms in one tag
assert(
  sanitizeFrictionTag('jane@x.com 555-123-4567') === '[redacted-email] [redacted-phone]',
  'email + phone both redacted',
)

// Edge cases
assert(sanitizeFrictionTag('') === '', 'empty string passes through')
assert(sanitizeFrictionTag('   ') === '', 'whitespace-only collapses to empty')

// Length clamp — over 80 chars truncated. Use a 100-char input.
const long = 'a'.repeat(100)
assert(sanitizeFrictionTag(long).length === 80, '100-char input truncated to 80')

// Length clamp + redaction interaction
const longWithEmail = 'aaaaaaaaaa jane@example.com bbbbbbbbbb'
const cleaned = sanitizeFrictionTag(longWithEmail)
assert(cleaned.includes('[redacted-email]'), 'email still redacted in mixed-content tag')
assert(!cleaned.includes('jane@example.com'), 'no raw email leaks')

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
