#!/usr/bin/env tsx
/**
 * Unit test — Tier 1.5 contradiction guard (AMEND-01 / golden case GC-4).
 *
 * Proves the deterministic safety rule that stops the cascade from fusing
 * two DISTINCT couples that share a name but differ on a strong (non-relay)
 * email or a far-apart wedding date — WITHOUT blocking the legitimate
 * relay→direct bridge (a relay address is medium-tier, never a contradicting
 * strong identifier). Pure functions, no DB.
 *
 * Run: npx tsx scripts/test-contradiction-guard.ts   (exit 0 pass / 1 fail)
 */
import { hardContradiction, cascadeMatch } from '@/lib/services/identity/identity-cascade'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

console.log('hardContradiction:')
check('two different strong emails → strong_email_conflict',
  hardContradiction('a@gmail.com', null, ['b@yahoo.com'], null) === 'strong_email_conflict')
check('wedding dates >90d apart → wedding_date_delta',
  hardContradiction('a@gmail.com', '2027-05-30', ['a@gmail.com'], '2026-09-12') === 'wedding_date_delta')
check('relay candidate email is NOT a strong conflict → null (allows bridge)',
  hardContradiction('a@gmail.com', null, ['doug.loxtercamp.772357@member.theknot.com'], null) === null,
  hardContradiction('a@gmail.com', null, ['doug.loxtercamp.772357@member.theknot.com'], null))
check('same email → null', hardContradiction('a@gmail.com', null, ['a@gmail.com'], null) === null)
check('differing emails VETOED by a corroborating close wedding date → null (two-partners / two-inboxes, one wedding)',
  hardContradiction('a@gmail.com', '2026-09-12', ['b@yahoo.com'], '2026-09-20') === null,
  hardContradiction('a@gmail.com', '2026-09-12', ['b@yahoo.com'], '2026-09-20'))
check('differing emails WITH a far wedding date → wedding_date_delta (distinct couples)',
  hardContradiction('a@gmail.com', '2026-09-12', ['b@yahoo.com'], '2027-09-20') === 'wedding_date_delta')
check('no signal email + no dates → null', hardContradiction(null, null, ['b@yahoo.com'], null) === null)
check('candidate has no strong email (relay only) + dates absent → null',
  hardContradiction('a@gmail.com', null, [null], null) === null)

console.log('cascadeMatch suppression (GC-4 shape):')
const twoSarahs = cascadeMatch(
  { firstName: 'Sarah', lastName: 'Miller', primaryEmail: 'different.sarah@yahoo.com', weddingDate: '2027-05-30' },
  [{ coupleId: 'A', weddingDate: '2026-09-12', people: [{ firstName: 'Sarah', lastName: 'Miller', email: 'sarah.m@gmail.com', phone: null }] }],
)
check('two distinct Sarahs (diff strong email + far date) do NOT match', twoSarahs.matched === false, twoSarahs)

console.log('cascadeMatch still bridges (GC-1 shape — relay → direct, same name):')
const dougBridge = cascadeMatch(
  { firstName: 'Doug', lastName: 'Loxtercamp', primaryEmail: 'dloxtercamp@gmail.com' },
  [{ coupleId: 'D', weddingDate: null, people: [{ firstName: 'Doug', lastName: 'Loxtercamp', email: 'doug.loxtercamp.772357@member.theknot.com', phone: null }] }],
)
check('Doug direct bridges to his Knot-relay couple (relay not a conflict)',
  dougBridge.matched === true && dougBridge.matched && dougBridge.coupleId === 'D', dougBridge)

console.log('cascadeMatch nickname stage (stage 3) is guarded:')
const nicknameConflict = cascadeMatch(
  { firstName: 'Mike', lastName: 'Smith', primaryEmail: 'mike@gmail.com', weddingDate: '2027-06-01' },
  [{ coupleId: 'M', weddingDate: '2026-01-01', people: [{ firstName: 'Michael', lastName: 'Smith', email: 'michael@yahoo.com', phone: null }] }],
)
check('Mike/Michael Smith with diff email + far date do NOT merge (stage 3 guarded)',
  nicknameConflict.matched === false, nicknameConflict)

console.log('cascadeMatch email-localpart logical stage (stage 5) — far-date probe:')
const localpartFarDate = cascadeMatch(
  { firstName: 'Xavier', lastName: 'Quint', primaryEmail: 'timmy.blogs@yahoo.com', weddingDate: '2027-06-01' },
  [{ coupleId: 'L', weddingDate: '2026-01-01', people: [{ firstName: 'Aaron', lastName: 'Vance', email: 'timothyblogs@gmail.com', phone: null }] }],
)
check('logical-localpart match across a >90d wedding-date gap must NOT merge (stage 5 date-guard)',
  localpartFarDate.matched === false, localpartFarDate)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — Tier 1.5 contradiction guard (GC-4)`)
process.exit(failures === 0 ? 0 : 1)
