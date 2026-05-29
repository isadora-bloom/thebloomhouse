#!/usr/bin/env tsx
/**
 * Unit test — Phase 1.1.b fidelity fix (N3 / GC-10).
 *
 * Proves `emailToNormalizedSignal` forwards full_body + rfc2822_headers
 * into raw_payload (so the spine no longer depends on the legacy
 * `interactions` row for content — gap G1), AND stays byte-identical to
 * the pre-1.1 shape when those fields are omitted (backward compat).
 *
 * Pure function, no DB. Run: npx tsx scripts/test-email-signal-fidelity.ts
 * Exit 0 = pass, 1 = fail.
 */
import { emailToNormalizedSignal } from '@/lib/services/identity/email-to-signal'

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const base = {
  email: { messageId: 'msg-1', threadId: 'thr-1', subject: 'Highland cows?' },
  interactionId: 'int-1',
  emailDate: '2026-02-01T10:00:00Z',
  rawFromName: 'Nadia Okafor',
  rawFromEmail: 'nadia@gmail.com',
}

// 1) With full fidelity supplied → raw_payload carries it.
console.log('case: fidelity fields supplied')
const body = 'We loved the highland cows — is October 2027 open? Budget ~45k.'
const headers = { 'message-id': '<msg-1@mail>', 'reply-to': 'nadia@gmail.com', dkim: 'pass' }
const withFidelity = emailToNormalizedSignal({ ...base, fullBody: body, rfc2822Headers: headers })
check('raw_payload.full_body === body', withFidelity.raw_payload.full_body === body)
check('raw_payload.rfc2822_headers === headers', withFidelity.raw_payload.rfc2822_headers === headers)
check('full_body is non-empty (the G1 point)', typeof withFidelity.raw_payload.full_body === 'string' && (withFidelity.raw_payload.full_body as string).length > 0)

// 2) Omitted → null (byte-identical legacy behaviour, no silent garbage).
console.log('case: fidelity fields omitted (backward compat)')
const legacy = emailToNormalizedSignal(base)
check('raw_payload.full_body === null', legacy.raw_payload.full_body === null)
check('raw_payload.rfc2822_headers === null', legacy.raw_payload.rfc2822_headers === null)
check('pre-existing raw_payload fields unchanged', legacy.raw_payload.subject === 'Highland cows?' && legacy.raw_payload.interaction_id === 'int-1' && legacy.raw_payload.raw_from_email === 'nadia@gmail.com')
check('matcher-facing primary fields unchanged', legacy.primary_email === 'nadia@gmail.com' && legacy.primary_name === 'Nadia Okafor')

// 3) Fidelity must not disturb identity resolution (relay-resolved path).
console.log('case: fidelity + relay-resolved identity coexist')
const relay = emailToNormalizedSignal({ ...base, resolvedEmail: 'real@couple.com', resolvedName: 'Real Couple', fullBody: body, rfc2822Headers: headers })
check('resolved identity still wins for primary_email', relay.primary_email === 'real@couple.com')
check('raw_from preserved for audit', relay.raw_payload.raw_from_email === 'nadia@gmail.com')
check('full_body still carried alongside resolved identity', relay.raw_payload.full_body === body)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — email-signal fidelity (1.1.b / GC-10)`)
process.exit(failures === 0 ? 0 : 1)
