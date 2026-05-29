#!/usr/bin/env tsx
/**
 * Unit test — Knot relay per-prospect key (regression lock for the
 * bloom-knot-relay-format-correction reversal, 2026-05-27 / f0a64aa).
 *
 * The trailing number in `<first>.<last>.<seq>.<venueId>@member.theknot.com`
 * is the VENUE's shared vendor-listing id, NOT a per-prospect id. The
 * per-prospect key MUST be the full localpart prefix. If this ever
 * regresses to returning the trailing number, EVERY Knot prospect at one
 * venue fuses into a single couple — a severe over-merge. This test makes
 * that regression impossible to merge.
 *
 * Pure functions, no DB. Run: npx tsx scripts/test-knot-relay-id.ts
 */
import { extractKnotPersonId } from '@/lib/services/identity/knot-sender-id'
import { cascadeMatch } from '@/lib/services/identity/identity-cascade'

let failures = 0
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  ✓ ${name}`)
  else { failures++; console.error(`  ✗ ${name}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`) }
}

const tara = 'tara.simpson.2.772357@member.theknot.com'
const taraReminder = 'Tara.Simpson.2.772357.reminder@member.theknot.com'
const megan = 'megan.wesley.2.772357@member.theknot.com' // SAME venue id 772357, different prospect

console.log('extractKnotPersonId:')
check('same prospect, initial + reminder → SAME key',
  extractKnotPersonId(tara) === extractKnotPersonId(taraReminder), [extractKnotPersonId(tara), extractKnotPersonId(taraReminder)])
check('different prospects sharing venue id 772357 → DIFFERENT keys (no over-merge)',
  extractKnotPersonId(tara) !== extractKnotPersonId(megan), [extractKnotPersonId(tara), extractKnotPersonId(megan)])
check('the key is the full prefix, NOT the bare venue number',
  extractKnotPersonId(tara) !== '772357' && (extractKnotPersonId(tara) ?? '').includes('tara'))
check('shared relay leads@theknot.com → null (never a key)', extractKnotPersonId('leads@theknot.com') === null)

console.log('cascadeMatch:')
const sameProspect = cascadeMatch(
  { primaryEmail: taraReminder, firstName: 'Tara', lastName: 'Simpson' },
  [{ coupleId: 'T', weddingDate: null, people: [{ firstName: 'Tara', lastName: 'Simpson', email: tara, phone: null }] }],
)
check('same prospect reminder bridges to initial (stage 1b dedup)',
  sameProspect.matched === true && sameProspect.matched && sameProspect.coupleId === 'T', sameProspect)

const diffProspectsSameVenue = cascadeMatch(
  { primaryEmail: megan, firstName: 'Megan', lastName: 'Wesley' },
  [{ coupleId: 'T', weddingDate: null, people: [{ firstName: 'Tara', lastName: 'Simpson', email: tara, phone: null }] }],
)
check('different prospects at the same venue do NOT match (no Knot over-merge)',
  diffProspectsSameVenue.matched === false, diffProspectsSameVenue)

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — Knot relay per-prospect key`)
process.exit(failures === 0 ? 0 : 1)
