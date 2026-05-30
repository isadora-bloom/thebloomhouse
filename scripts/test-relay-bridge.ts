#!/usr/bin/env tsx
/**
 * Unit test — relay-partial first-name bridge scoring (GC-2 / cross-source).
 *
 * Proves the matcher routes a relay-partial-identity vs full-identity
 * first-name match into the LLM judge band (40-90, needs_judge) rather
 * than scoring it below_threshold (which mints a silent duplicate couple).
 * It must NOT fire for two full identities, and must never alone reach
 * auto-attach (100). Pure function, no DB / no LLM.
 *
 * Run: npx tsx scripts/test-relay-bridge.ts
 */
import { scoreCandidate, type MatchableRecord } from '@/lib/services/identity/matcher'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

const rec = (p: Partial<MatchableRecord>): MatchableRecord => ({
  id: 'x', primary_name: null, primary_email: null, primary_phone: null,
  partner_name: null, partner_email: null, partner_phone: null,
  wedding_date: null, observed_at: null, session_ip: null, session_fingerprint: null,
  ...(p as object),
} as MatchableRecord)

// Relay-partial (Knot first + last-initial) vs full identity, first name matches.
const bridge = scoreCandidate(
  rec({ id: 'calc', primary_name: 'Ashley Bennett', primary_email: 'ashleybennett@gmail.com' }),
  rec({ id: 'knot', primary_name: 'Ashley B', primary_email: 'ashley.b.5521@member.theknot.com' }),
)
check('relay-partial first-name pair lands in the judge band (needs_judge)', bridge.needs_judge === true, bridge.tier)
check('relay_partial_first_name signal present', bridge.signals.some((s) => s.name === 'relay_partial_first_name'))
check('score stays below auto-attach (100)', bridge.score < 100, bridge.score)

// Two FULL identities, same first name, different last name + email → must NOT fire the relay bridge
// (they are handled by the normal name scorer / contradiction guard, not this signal).
const twoFull = scoreCandidate(
  rec({ id: 'a', primary_name: 'Ashley Bennett', primary_email: 'ashleybennett@gmail.com' }),
  rec({ id: 'b', primary_name: 'Ashley Carter', primary_email: 'ashley.carter@yahoo.com' }),
)
check('two full identities do NOT trigger the relay bridge',
  !twoFull.signals.some((s) => s.name === 'relay_partial_first_name'))

// Relay-partial but DIFFERENT first name → no bridge.
const diffFirst = scoreCandidate(
  rec({ id: 'c', primary_name: 'Brianna Bennett', primary_email: 'brianna@gmail.com' }),
  rec({ id: 'd', primary_name: 'Ashley B', primary_email: 'ashley.b.5521@member.theknot.com' }),
)
check('different first names → no relay bridge',
  !diffFirst.signals.some((s) => s.name === 'relay_partial_first_name'))

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — relay-partial first-name bridge`)
process.exit(failures === 0 ? 0 : 1)
