// Regression tests for parseWeddingWire authsolic-token extraction.
import { detectFormRelay } from '../src/lib/services/form-relay-parsers'

const REAL_BODY_KELLIE = `

Kellie Phillis says:

Kellie Phillis says:

Hello,
What would be an estimate for a
Small, all inclusive wedding for 50-60?
That will help the B&G narrow down venue tours.
Thank you,
Melissa Phillis MOB

For: Rixey Manor

Reply

Reply directly to this email or view on WeddingPro
[https://www.weddingwire.com/emp-mail-TraceClick.php?tipo=EMP_RESPUESTA_USUARIO&durl=%2F%2Fwww.weddingwire.com%2Fpreq.php%3Fauthsolic%3D89436314x5bc3841a91c6ac001d558cb&utm_source=emp_respuesta_usuario&utm_medium=email&utm_campaign=emp_respuesta_usuario&utm_idTrackE=111987418]


Your messages may be monitored for quality, safety, and security
according to our Acceptable Content Policy
[https://www.theknotww.com/legalhub/content-moderation-policy/]

Privacy Policy [https://www.theknotww.com/privacy-policy/]

© 2026 The Knot Worldwide Inc. All rights reserved. 2 Wisconsin
Circle, 3rd Floor, Chevy Chase, MD 20815. WeddingPro is a trademark of
The Knot Worldwide Inc.`

interface Case {
  name: string
  email: { from: string; to: string; subject: string; body: string }
  expect: { source: string; leadEmail: string; leadName: string }
}

const cases: Case[] = [
  {
    name: 'WW: extracts authsolic token + name from real body',
    email: {
      from: 'WeddingWire <messages@weddingwire.com>',
      to: 'info@rixeymanor.com',
      subject: '📩 Kellie Phillis sent you a new message',
      body: REAL_BODY_KELLIE,
    },
    expect: {
      source: 'wedding_wire',
      leadEmail: 'authsolic-89436314x5bc3841a91c6ac001d558cb@weddingwire.bloom-relay.invalid',
      leadName: 'Kellie Phillis',
    },
  },
  {
    name: 'WW: different prospect → different synthetic email',
    email: {
      from: 'messages@weddingwire.com',
      to: 'info@rixeymanor.com',
      subject: '📩 Aidan Henry sent you a new message',
      body: 'Aidan Henry says:\nHey there!\n[https://www.weddingwire.com/emp-mail-TraceClick.php?durl=%2F%2Fwww.weddingwire.com%2Fpreq.php%3Fauthsolic%3D11111111x222aaa]',
    },
    expect: {
      source: 'wedding_wire',
      leadEmail: 'authsolic-11111111x222aaa@weddingwire.bloom-relay.invalid',
      leadName: 'Aidan Henry',
    },
  },
  {
    name: 'WW: "Don\'t leave X hanging" subject pattern',
    email: {
      from: 'messages@weddingwire.com',
      to: 'info@rixeymanor.com',
      subject: "📩 Don't leave Aidan Henry hanging!",
      body: '[https://example.com/?authsolic%3Dabcdef1234567890abcdef]',
    },
    expect: {
      source: 'wedding_wire',
      leadEmail: 'authsolic-abcdef1234567890abcdef@weddingwire.bloom-relay.invalid',
      leadName: 'Aidan Henry',
    },
  },
]

let pass = 0
let fail = 0
for (const c of cases) {
  const r = detectFormRelay(c.email, new Set(['info@rixeymanor.com']))
  const fails: string[] = []
  if (!r) fails.push('detection returned null')
  else {
    if (r.source !== c.expect.source) fails.push(`source "${r.source}" expected "${c.expect.source}"`)
    if (r.leadEmail !== c.expect.leadEmail) fails.push(`leadEmail "${r.leadEmail}" expected "${c.expect.leadEmail}"`)
    if (r.leadName !== c.expect.leadName) fails.push(`leadName "${r.leadName}" expected "${c.expect.leadName}"`)
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
