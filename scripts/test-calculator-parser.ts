// Regression tests for parseVenueCalculator. Run with:
//   npx tsx scripts/test-calculator-parser.ts
//
// Locks in the strong-vs-weak detection split and the Ryan-Schubert
// case (calculator email from a venue alias not registered in
// gmail_connections — must still extract the prospect).
import { detectFormRelay } from '../src/lib/services/ingestion/form-relay-parsers'

interface Case {
  name: string
  email: { from: string; to: string; subject: string; body: string }
  ownEmails: Set<string>
  expect: { source: string; leadEmail: string; leadName: string | null }
}

const cases: Case[] = [
  {
    name: 'Ryan Schubert calculator from un-registered venue alias',
    email: {
      from: 'hello@rixeymanor.com',
      to: 'info@rixeymanor.com',
      subject: 'New estimate: Ryan Schubert & Madison Bryant — $14,663',
      // Real body shape from the orphan in production.
      body: `NEW CALCULATOR SUBMISSION

Wednesday, April 15, 2026

Ryan Schubert & Madison Bryant

twisters42@gmail.com

3017887449

Season: Fall
Guests: 50–100
Overnight stays: Two nights
5% discounts: Using Only Recommended Vendors
10% discounts: Military / Veteran / First Responder
Estimated total: $14,663
Per payment (×3): $4,888

Date in mind: Late October- Early November 2027

Next steps: Be contacted with more information`,
    },
    // Note: hello@rixeymanor.com is NOT in ownEmails. Only info@ is
    // registered. Strong detection ('NEW CALCULATOR SUBMISSION' marker
    // in body) bypasses the venueOwn requirement.
    ownEmails: new Set(['info@rixeymanor.com']),
    expect: { source: 'venue_calculator', leadEmail: 'twisters42@gmail.com', leadName: null },
  },
  {
    name: 'Standard calculator from registered venue alias still works',
    email: {
      from: 'info@rixeymanor.com',
      to: 'info@rixeymanor.com',
      subject: 'Your Rixey Manor estimate',
      body: `Estimated total: $12,000\nSeason: Spring\nGuests: 80\nbride@example.com\n`,
    },
    ownEmails: new Set(['info@rixeymanor.com']),
    expect: { source: 'venue_calculator', leadEmail: 'bride@example.com', leadName: null },
  },
]

let pass = 0
let fail = 0
for (const c of cases) {
  const result = detectFormRelay(c.email, c.ownEmails)
  const fails: string[] = []
  if (!result) {
    fails.push('detection returned null')
  } else {
    if (result.source !== c.expect.source) fails.push(`source "${result.source}" expected "${c.expect.source}"`)
    if (result.leadEmail !== c.expect.leadEmail) fails.push(`leadEmail "${result.leadEmail}" expected "${c.expect.leadEmail}"`)
  }
  if (fails.length === 0) {
    console.log(`  PASS  ${c.name}`)
    pass++
  } else {
    console.log(`  FAIL  ${c.name}`)
    for (const f of fails) console.log(`        ${f}`)
    fail++
  }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
