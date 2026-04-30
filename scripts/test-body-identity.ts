// Regression tests for extractIdentityFromEmail. Run with:
//   npx tsx scripts/test-body-identity.ts
import { extractIdentityFromEmail } from '../src/lib/services/body-identity-extract'

interface Case {
  name: string
  input: { subject?: string; body: string }
  ownEmails?: Set<string>
  expect: {
    primary_email: string | null
    has_phone?: boolean
    has_name?: boolean
  }
}

const cases: Case[] = [
  {
    name: 'Calculator body — extracts prospect email + phone + names',
    input: {
      subject: 'New estimate: Ryan Schubert & Madison Bryant — $14,663',
      body: `NEW CALCULATOR SUBMISSION

Ryan Schubert & Madison Bryant

twisters42@gmail.com

3017887449

Season: Fall
Guests: 50–100`,
    },
    ownEmails: new Set(['info@rixeymanor.com']),
    expect: { primary_email: 'twisters42@gmail.com', has_phone: true, has_name: true },
  },
  {
    name: 'WW relay body — name in body, no email = primary_email null',
    input: {
      subject: '📩 Kellie Phillis sent you a new message',
      body: `Kellie Phillis says:
Hello, What would be an estimate for a small all-inclusive wedding for 50-60?
For: Rixey Manor
Reply directly to this email or view on WeddingPro`,
    },
    ownEmails: new Set(['info@rixeymanor.com']),
    expect: { primary_email: null, has_name: true },
  },
  {
    name: 'Plain inquiry — extracts the customer email even when From is fine',
    input: {
      subject: 'Wedding venue inquiry',
      body: `Hi! I'm Sarah Johnson and I'd love to learn about your venue. You can reach me at sarah.johnson@example.com or 555-867-5309. We're thinking June 2027, around 100 guests. Thanks!`,
    },
    ownEmails: new Set(['info@rixeymanor.com']),
    expect: { primary_email: 'sarah.johnson@example.com', has_phone: true, has_name: true },
  },
  {
    name: 'Excludes venue-own emails from primary_email',
    input: {
      body: `Test from info@rixeymanor.com to bride@example.com about the wedding.`,
    },
    ownEmails: new Set(['info@rixeymanor.com']),
    expect: { primary_email: 'bride@example.com' },
  },
  {
    name: 'Excludes known-relay domains from primary_email',
    input: {
      body: `From notifications@calendly.com to messages@weddingwire.com — actual prospect: real@gmail.com`,
    },
    expect: { primary_email: 'real@gmail.com' },
  },
]

let pass = 0
let fail = 0
for (const c of cases) {
  const r = extractIdentityFromEmail(c.input, { ownEmails: c.ownEmails })
  const fails: string[] = []
  if (r.primary_email !== c.expect.primary_email) {
    fails.push(`primary_email "${r.primary_email}" expected "${c.expect.primary_email}"`)
  }
  if (c.expect.has_phone && r.phones.length === 0) fails.push('expected at least one phone')
  if (c.expect.has_name && r.names.length === 0) fails.push('expected at least one name')
  if (fails.length === 0) {
    console.log(`  PASS  ${c.name}`)
    pass++
  } else {
    console.log(`  FAIL  ${c.name}`)
    for (const f of fails) console.log(`        ${f}`)
    console.log(`        actual: ${JSON.stringify(r)}`)
    fail++
  }
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail === 0 ? 0 : 1)
