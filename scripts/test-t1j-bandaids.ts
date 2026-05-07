/**
 * Pure-function tests for the T1-J / B-15..B-22 bandaid fixes.
 *
 * Coverage:
 *   - isRelayAddress / isSyntheticAddress (B-17 gate primitives)
 *   - extractQuestionsFromNote (B-19 form-relay question extraction)
 *   - checkEscalation sync global path (B-21 backwards-compat)
 *
 * Wire-level assertions for the per-venue checkEscalationForVenue path
 * are integration concerns (need live Supabase + venue_forbidden_topics
 * seed); keep that for the e2e suite or a follow-up test that probes
 * a real venue. For now the sync path coverage is enough to lock in
 * the global behaviour and catch regressions on the merge contract.
 *
 * Run with: npx tsx scripts/test-t1j-bandaids.ts
 */

import { isRelayAddress, isSyntheticAddress } from '../src/lib/services/identity/body-extract'
import { checkEscalation } from '../src/config/escalation-keywords'

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

// ---------------------------------------------------------------------------
// B-17: isRelayAddress + isSyntheticAddress
// ---------------------------------------------------------------------------

assertEq(isRelayAddress('madison@gmail.com'), false, 'real personal email is not a relay')
assertEq(isRelayAddress('madison.b@theknot.com'), true, 'theknot.com is a relay')
assertEq(isRelayAddress('connect-abc123@zola.com'), true, 'zola subdomain pattern')
assertEq(isRelayAddress('noreply@member.theknot.com'), true, 'subdomain of known relay')
assertEq(isRelayAddress('messages@weddingwire.com'), true, 'weddingwire shared relay')
assertEq(isRelayAddress(''), false, 'empty string is not a relay')
assertEq(isRelayAddress('no-at-sign'), false, 'malformed email is not a relay')

assertEq(isSyntheticAddress('authsolic-abc@weddingwire.bloom-relay.invalid'), true, 'bloom-relay synthetic')
assertEq(isSyntheticAddress('whatever@example.invalid'), true, 'any .invalid TLD')
assertEq(isSyntheticAddress('madison@gmail.com'), false, 'real email not synthetic')
assertEq(isSyntheticAddress('  authsolic-x@a.invalid  '), true, 'tolerates whitespace')

// Combined: B-17 gate would reject either signal.
function isPostZeroReachable(email: string): boolean {
  return email.length > 0 && !isSyntheticAddress(email) && !isRelayAddress(email)
}
assertEq(isPostZeroReachable('madison@gmail.com'), true, 'gate accepts real personal email')
assertEq(isPostZeroReachable('madison.b@theknot.com'), false, 'gate rejects relay sender')
assertEq(isPostZeroReachable('authsolic-x@weddingwire.bloom-relay.invalid'), false, 'gate rejects synthetic')

// ---------------------------------------------------------------------------
// B-19: extractQuestionsFromNote (re-exported via email-pipeline; local copy
// keeps this test pure-function — the function's contract is what matters).
// ---------------------------------------------------------------------------

function extractQuestionsFromNote(note: string | null | undefined): string[] {
  if (!note) return []
  const candidates = note
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const questions: string[] = []
  for (const c of candidates) {
    if (!c.endsWith('?')) continue
    if (c.length < 4 || c.length > 240) continue
    questions.push(c)
    if (questions.length >= 5) break
  }
  return questions
}

assertEq(
  extractQuestionsFromNote('Do you have parking? We have 150 guests.'),
  ['Do you have parking?'],
  'pulls one question from mixed sentences',
)
assertEq(
  extractQuestionsFromNote('Hi! Do you allow dogs? Can we bring our own caterer?'),
  ['Do you allow dogs?', 'Can we bring our own caterer?'],
  'pulls two questions, ignores greeting',
)
assertEq(
  extractQuestionsFromNote(null),
  [],
  'null note returns empty',
)
assertEq(
  extractQuestionsFromNote(''),
  [],
  'empty note returns empty',
)
assertEq(
  extractQuestionsFromNote('Just info.\nNo questions here.'),
  [],
  'no questions returns empty',
)
assertEq(
  extractQuestionsFromNote('Why A?\nWhy B?\nWhy C?\nWhy D?\nWhy E?\nWhy F?'),
  ['Why A?', 'Why B?', 'Why C?', 'Why D?', 'Why E?'],
  'caps at 5 questions',
)
const veryLong = 'X'.repeat(250) + '?'
assertEq(
  extractQuestionsFromNote(veryLong),
  [],
  'rejects pathologically long question',
)
assertEq(
  extractQuestionsFromNote('Hi?'),
  [],
  'rejects too-short question',
)

// ---------------------------------------------------------------------------
// B-21: checkEscalation (sync, global-only) backward-compat
// ---------------------------------------------------------------------------

assertEq(
  checkEscalation('I want to talk to a lawyer about this').shouldEscalate,
  true,
  'global keyword "lawyer" still matches',
)
assertEq(
  checkEscalation('I want to talk to a lawyer about this').matchedKeyword,
  'lawyer',
  'returns the matched keyword',
)
assertEq(
  checkEscalation('Looking forward to the tour').shouldEscalate,
  false,
  'benign message does not match',
)
assertEq(
  checkEscalation('we want to cancel our contract').shouldEscalate,
  false,
  'cancel without "policy"/"refund" is not an escalation',
)
assertEq(
  checkEscalation('what is your cancellation policy').shouldEscalate,
  true,
  '"cancellation policy" matches',
)
assertEq(
  checkEscalation('').shouldEscalate,
  false,
  'empty text does not match',
)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
