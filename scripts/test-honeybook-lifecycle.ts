/**
 * Pure-function tests for T2-F HoneyBook lifecycle events.
 *
 * Verifies:
 *   - parseHoneyBook detects all 4 lifecycle kinds (signed / payment /
 *     refund / amendment) from realistic HoneyBook subjects + bodies
 *   - Detection precedence: refund > amendment > payment > signed > sent
 *     (most specific wins so an "amendment + payment" subject doesn't
 *      mis-classify as payment)
 *   - eventKindToEngagementType maps each lifecycle kind to the literal
 *     honeybook_<kind> event_type (forensic record per ARCH-11.5-B)
 *   - eventKindToStatus: signed/payment → 'booked', refund/amendment → null
 *   - normalizeEventTypeForScoring un-prefixes signed + payment so heat /
 *     attribution / signal-inference can treat them as contract_signed
 *
 * Run with: npx tsx scripts/test-honeybook-lifecycle.ts
 */

import {
  detectSchedulingEvent,
  eventKindToEngagementType,
  eventKindToStatus,
  normalizeEventTypeForScoring,
  type SchedulingEventKind,
} from '../src/lib/services/scheduling-tool-parsers'

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

function detect(subject: string, body: string) {
  return detectSchedulingEvent({
    from: 'notifications@honeybook.com',
    subject,
    body,
  })
}

// ---------------------------------------------------------------------------
// 1. Lifecycle kind detection
// ---------------------------------------------------------------------------

const HBOOK_BODY = (extra: string) => `
Hi there!

Madison Bryant just took an action on your project.

${extra}

Project: Bryant Wedding
Client: Madison Bryant
Email: madison.b@gmail.com
View in HoneyBook: https://www.honeybook.com/projects/abc123
`

assertEq(
  detect('Madison signed the contract', HBOOK_BODY('Madison signed the contract this morning'))?.kind,
  'honeybook_contract_signed',
  '"signed the contract" → honeybook_contract_signed',
)

assertEq(
  detect('Proposal accepted', HBOOK_BODY('Madison accepted the proposal'))?.kind,
  'honeybook_contract_signed',
  '"accepted the proposal" → honeybook_contract_signed',
)

assertEq(
  detect('Booking confirmed', HBOOK_BODY('Booking confirmed for Sept 14'))?.kind,
  'honeybook_contract_signed',
  '"booking confirmed" → honeybook_contract_signed',
)

assertEq(
  detect('Payment received', HBOOK_BODY('Payment received: $5,000 deposit'))?.kind,
  'honeybook_payment_received',
  '"payment received" → honeybook_payment_received',
)

assertEq(
  detect('Invoice paid', HBOOK_BODY('Invoice paid in full — $25,000'))?.kind,
  'honeybook_payment_received',
  '"invoice paid" → honeybook_payment_received',
)

assertEq(
  detect('Retainer received', HBOOK_BODY('Retainer received from the couple'))?.kind,
  'honeybook_payment_received',
  '"retainer received" → honeybook_payment_received',
)

assertEq(
  detect('Refund issued', HBOOK_BODY('Refund issued for $5,000 deposit'))?.kind,
  'honeybook_refund',
  '"refund issued" → honeybook_refund',
)

assertEq(
  detect('Cancellation processed', HBOOK_BODY('Cancellation processed by client'))?.kind,
  'honeybook_refund',
  '"cancellation processed" → honeybook_refund',
)

assertEq(
  detect('Amendment to contract', HBOOK_BODY('Amendment added: changed guest count to 200'))?.kind,
  'honeybook_amendment',
  '"amendment" → honeybook_amendment',
)

assertEq(
  detect('Contract update', HBOOK_BODY('Contract update: new date Oct 5'))?.kind,
  'honeybook_amendment',
  '"contract update" → honeybook_amendment',
)

assertEq(
  detect('Updated proposal', HBOOK_BODY('Updated proposal sent to client'))?.kind,
  'honeybook_amendment',
  '"updated proposal" → honeybook_amendment',
)

// ---------------------------------------------------------------------------
// 2. Detection precedence: refund > amendment > payment > signed > sent
// ---------------------------------------------------------------------------

// Subject mentions both refund and signed — refund must win because
// it's the actual current state change.
assertEq(
  detect('Refund issued for previously signed contract', HBOOK_BODY(''))?.kind,
  'honeybook_refund',
  'refund beats signed in precedence',
)

// Subject mentions both amendment and payment — amendment wins
// because it's more specific.
assertEq(
  detect('Amendment with payment update', HBOOK_BODY(''))?.kind,
  'honeybook_amendment',
  'amendment beats payment in precedence',
)

// Subject mentions both payment and signed — payment wins because
// the regex pattern is more specific (and signed regex requires
// "contract signed" / "signed the contract" not just "signed").
assertEq(
  detect('Payment received on signed contract', HBOOK_BODY('Payment received'))?.kind,
  'honeybook_payment_received',
  'payment beats signed in precedence',
)

// No lifecycle keywords → contract_sent default (existing behavior).
assertEq(
  detect('Project created', HBOOK_BODY('A new project has been created'))?.kind,
  'contract_sent',
  'no lifecycle keyword → contract_sent default',
)

// ---------------------------------------------------------------------------
// 3. eventKindToEngagementType maps each lifecycle kind 1:1
// ---------------------------------------------------------------------------

assertEq(eventKindToEngagementType('honeybook_contract_signed'), 'honeybook_contract_signed', 'engagement type for signed')
assertEq(eventKindToEngagementType('honeybook_payment_received'), 'honeybook_payment_received', 'engagement type for payment')
assertEq(eventKindToEngagementType('honeybook_refund'), 'honeybook_refund', 'engagement type for refund')
assertEq(eventKindToEngagementType('honeybook_amendment'), 'honeybook_amendment', 'engagement type for amendment')

// Pre-T2-F kinds still map cleanly.
assertEq(eventKindToEngagementType('contract_signed'), 'contract_signed', 'generic contract_signed unchanged')
assertEq(eventKindToEngagementType('payment_received'), 'contract_signed', 'generic payment_received → contract_signed (legacy)')
assertEq(eventKindToEngagementType('tour_scheduled'), 'tour_scheduled', 'tour_scheduled unchanged')

// ---------------------------------------------------------------------------
// 4. eventKindToStatus
// ---------------------------------------------------------------------------

assertEq(eventKindToStatus('honeybook_contract_signed'), 'booked', 'signed → booked')
assertEq(eventKindToStatus('honeybook_payment_received'), 'booked', 'payment → booked')
assertEq(eventKindToStatus('honeybook_refund'), null, 'refund → null (coordinator decides)')
assertEq(eventKindToStatus('honeybook_amendment'), null, 'amendment → null (informational)')

// ---------------------------------------------------------------------------
// 5. normalizeEventTypeForScoring un-prefixes signed + payment
// ---------------------------------------------------------------------------

assertEq(normalizeEventTypeForScoring('honeybook_contract_signed'), 'contract_signed', 'normalize signed → contract_signed')
assertEq(normalizeEventTypeForScoring('honeybook_payment_received'), 'contract_signed', 'normalize payment → contract_signed')
assertEq(normalizeEventTypeForScoring('honeybook_refund'), 'honeybook_refund', 'normalize refund passes through')
assertEq(normalizeEventTypeForScoring('honeybook_amendment'), 'honeybook_amendment', 'normalize amendment passes through')
assertEq(normalizeEventTypeForScoring('contract_signed'), 'contract_signed', 'unprefixed unchanged')
assertEq(normalizeEventTypeForScoring('tour_scheduled'), 'tour_scheduled', 'tour event passes through')
assertEq(normalizeEventTypeForScoring('initial_inquiry'), 'initial_inquiry', 'initial_inquiry unchanged')
assertEq(normalizeEventTypeForScoring('made_up_event'), 'made_up_event', 'unknown types pass through')

// ---------------------------------------------------------------------------
// 6. Non-HoneyBook senders never fire lifecycle kinds
// ---------------------------------------------------------------------------

const nonHB = detectSchedulingEvent({
  from: 'notifications@calendly.com',
  subject: 'Refund issued',
  body: 'Refund of $50',
})
// Calendly parser doesn't do refunds — should either return null or
// a Calendly tour_scheduled depending on body. The point is that no
// honeybook_ kind leaks across senders.
if (!nonHB || !nonHB.kind.startsWith('honeybook_')) pass++
else { fail++; console.error('FAIL: non-HoneyBook sender produced honeybook_ kind') }

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
