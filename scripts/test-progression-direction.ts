/**
 * D5 direction-discipline lock (Canonical v1.0 §3.4 / §5, migration 380,
 * CONSOLIDATION-PLAN-PHASED.md v2.1 §1.8).
 *
 * The decay clock (couples.last_progression_at) moves ONLY on couple-side
 * inbound, doctrine-listed action types. That invariant is enforced
 * structurally by `progressionEventTypeFor` — outbound/venue-side actions
 * map to null, so `recordProgressionIfEligible` never writes a progression
 * row and never bumps the clock. This test locks the mapper so a future
 * edit can't quietly make an outbound action progression-eligible
 * (GC-9's "outbound never resets decay" — the deterministic half; the
 * heat-axis half stays pending the M2 heat-model collapse).
 *
 * Run: npx tsx scripts/test-progression-direction.ts
 */

import { progressionEventTypeFor } from '../src/lib/services/identity/progression'
import type { NormalizedSignal } from '../src/lib/services/identity/sources/types'

let failures = 0
function check(name: string, ok: boolean) {
  if (ok) {
    console.log(`  PASS ${name}`)
  } else {
    failures += 1
    console.error(`  FAIL ${name}`)
  }
}

function sig(channel: string, action: string): NormalizedSignal {
  return {
    venue_id: 'v-test',
    channel,
    action_type: action,
    occurred_at: '2026-06-01T00:00:00Z',
    external_id: `test-${channel}-${action}`,
    signal_tier: 'high',
    raw_payload: {},
  } as unknown as NormalizedSignal
}

console.log('D5: outbound / venue-side actions must NEVER be progression-eligible')
// The explicit outbound exclusions, across every channel they can ride on.
for (const channel of ['gmail', 'sms', 'phone', 'honeybook', 'calendly']) {
  for (const action of ['venue_sent', 'outbound', 'auto_send']) {
    check(
      `${channel}/${action} -> null`,
      progressionEventTypeFor(sig(channel, action)) === null,
    )
  }
}
// Channel-specific outbound / non-progression shapes.
check('sms/sms_outbound -> null', progressionEventTypeFor(sig('sms', 'sms_outbound')) === null)
check(
  'calendly/tour_cancelled -> null (regression, not progression)',
  progressionEventTypeFor(sig('calendly', 'tour_cancelled')) === null,
)
check(
  'honeybook/crm_imported_lost -> null (terminal, not progression)',
  progressionEventTypeFor(sig('honeybook', 'crm_imported_lost')) === null,
)
check(
  'honeybook/crm_attribution -> null (provenance, not couple action)',
  progressionEventTypeFor(sig('honeybook', 'crm_attribution')) === null,
)
check(
  'unknown channel/action falls through to null',
  progressionEventTypeFor(sig('carrier-pigeon', 'flew_by')) === null,
)

console.log('D5: couple-side inbound doctrine-listed actions stay eligible')
const inboundExpectations: Array<[string, string, string]> = [
  ['gmail', 'reply', 'email_reply'],
  ['gmail', 'inquiry', 'email_reply'],
  ['gmail', 'human_requested', 'inbound_human_request'],
  ['calendly', 'tour_booked', 'tour_booked'],
  ['calendly', 'tour_attended', 'tour_attended'],
  ['knot', 'inquiry', 'new_channel_inquiry'],
  ['zola', 'message', 'new_channel_inquiry'],
  ['website', 'inquiry_form_submitted', 'new_channel_inquiry'],
  ['honeybook', 'contract_signed', 'contract_signed'],
  ['honeybook', 'crm_imported_inquiry', 'crm_inquiry'],
  ['sms', 'sms_inbound', 'inbound_sms'],
  ['phone', 'inbound_call', 'inbound_call'],
  ['voicemail', 'voicemail_received', 'voicemail_received'],
  ['zoom', 'meeting_completed', 'meeting_completed'],
]
for (const [channel, action, expected] of inboundExpectations) {
  check(
    `${channel}/${action} -> ${expected}`,
    progressionEventTypeFor(sig(channel, action)) === expected,
  )
}

if (failures > 0) {
  console.error(`\ntest-progression-direction: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\ntest-progression-direction: all assertions pass')
