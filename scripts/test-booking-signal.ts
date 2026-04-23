// Edge-case tests for detectBookingSignal. Run with:
//   npx tsx scripts/test-booking-signal.ts
//
// Locks in the regex set against regression. Every pattern in
// src/lib/services/booking-signal.ts has at least one positive case
// here, plus negatives that should NOT match (enthusiastic
// inquiry-stage emails are the false-positive risk).
import { detectBookingSignal } from '../src/lib/services/booking-signal'

type Case = { body: string; matches: boolean; reason: string }

const cases: Case[] = [
  // Contract language — positives
  { body: 'We signed the contract yesterday!', matches: true, reason: 'signed the contract' },
  { body: 'The contract is signed — what is next?', matches: true, reason: 'contract is signed' },
  { body: 'I just sent the signed contract over email', matches: true, reason: 'sent the signed' },
  { body: 'Signed and returned, see attached', matches: true, reason: 'signed and returned' },
  { body: "We've signed, can you confirm receipt?", matches: true, reason: "we've signed" },
  { body: 'Just signed! Thank you so much.', matches: true, reason: 'just signed' },
  { body: 'Attached is the signed PDF', matches: true, reason: 'attached ... signed' },
  { body: 'The signed version is attached below', matches: true, reason: 'signed ... attached' },

  // Deposit / retainer — positives
  { body: 'The deposit has been paid this morning', matches: true, reason: 'deposit has been paid' },
  { body: 'Retainer paid via wire transfer', matches: true, reason: 'retainer paid' },
  { body: 'The retainer was received yesterday', matches: true, reason: 'retainer was received' },
  { body: 'Paid the deposit earlier today, confirm?', matches: true, reason: 'paid the deposit' },
  { body: 'We paid the retainer via ACH', matches: true, reason: 'paid the retainer' },

  // Commitment — positives
  { body: "We're officially booked for June 14!", matches: true, reason: "we're officially booked" },
  { body: 'We are booked for next year.', matches: true, reason: 'we are booked' },
  { body: 'Booking is confirmed — date set.', matches: true, reason: 'booking is confirmed' },
  { body: 'Booking confirmed, thanks!', matches: true, reason: 'booking confirmed' },
  { body: "We're official!", matches: true, reason: "we're official!" },
  { body: 'We are officially locked in.', matches: true, reason: 'we are officially' },

  // Enthusiasm at inquiry stage — negatives
  { body: "We're so excited about your venue", matches: false, reason: 'inquiry-stage excitement, not booking' },
  { body: 'We love the place and want to learn more', matches: false, reason: 'interest, not commitment' },
  { body: 'Do you have availability for fall 2026?', matches: false, reason: 'pure availability question' },
  { body: 'Could you send pricing?', matches: false, reason: 'pricing request' },
  { body: 'We signed up for the newsletter', matches: false, reason: '"signed up" is not "signed the contract"' },

  // Edge cases
  { body: '', matches: false, reason: 'empty body' },
  { body: '   ', matches: false, reason: 'whitespace body' },
  // Case insensitivity — patterns use /i flag
  { body: 'THE CONTRACT IS SIGNED', matches: true, reason: 'uppercase contract sign' },
  { body: 'Weve signed with you — no apostrophe', matches: true, reason: "weve without apostrophe" },

  // "signed" alone should NOT match
  { body: 'She signed up for the tour Saturday', matches: false, reason: '"signed up" is unrelated' },
  { body: 'I just signed my name on the form', matches: true, reason: '"just signed" still fires (template regex is loose; consider tightening later if false positives appear)' },

  // Long body with signing phrase embedded
  {
    body: 'Thanks for the quick reply. After chatting with Marcus and both sets of parents, we decided to move forward. We signed the contract this evening and will wire the deposit tomorrow morning. Looking forward to it!',
    matches: true,
    reason: 'long body with "signed the contract"',
  },
]

let pass = 0
let fail = 0
const failures: string[] = []
for (const c of cases) {
  const result = detectBookingSignal(c.body)
  const ok = result.matched === c.matches
  if (ok) pass++
  else {
    fail++
    failures.push(
      `  [FAIL] body=${JSON.stringify(c.body.slice(0, 60))} expected matched=${c.matches} got=${result.matched} phrase=${result.phrase}   (${c.reason})`
    )
  }
}

console.log(`detectBookingSignal: ${pass}/${pass + fail} passed`)
for (const f of failures) console.log(f)
process.exit(fail > 0 ? 1 : 0)
