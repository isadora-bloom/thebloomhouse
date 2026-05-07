// Regression tests for parseCalendly. Run with:
//   npx tsx scripts/test-calendly-parser.ts
//
// Each fixture is a real-shape Calendly email body (HTML form,
// inline `style='...'` attributes on every tag — the actual format
// Calendly emits). Tests verify parseCalendly returns the right
// eventDatetime and inviteeEmail rather than HTML fragments.
//
// 2026-04-30: stripHtml's `<br>` regex previously only matched bare
// `<br>` / `<br/>`, leaving Calendly's `<br style='...'>` to fall
// through to the catch-all stripper. The label and value would then
// share a line and extractLabelled could grab the closing tag
// fragment ("</strong>") instead of the actual datetime. Fixed by
// widening the block-tag pattern to tolerate attributes.

import { detectSchedulingEvent } from '../src/lib/services/ingestion/scheduling-tool-parsers'

interface TestCase {
  name: string
  from: string
  subject: string
  body: string
  expect: {
    eventDatetime: string | { contains: string }
    inviteeEmail: string
    kind: string
  }
}

const cases: TestCase[] = [
  {
    name: 'Calendly New Event with inline-styled <br>',
    from: 'no-reply@calendly.com',
    subject: 'New Event: Ryan Schubert - 06:00pm Mon, Apr 13, 2026 - Rixey Manor Venue Tour',
    body: `<p style='font-family:"Proxima Nova"'>
  <strong style='font-family:"Proxima Nova";font-size: 14px;'>
    Event Type:
  </strong>
  <br style='font-family:"Proxima Nova"'>
  Rixey Manor Venue Tour
</p>

<p style='font-family:"Proxima Nova"'>
  <strong style='font-family:"Proxima Nova";font-size: 14px;'>
    Invitee Email:
  </strong>
  <br style='font-family:"Proxima Nova"'>
  <a href="mailto:twisters42@gmail.com">twisters42@gmail.com</a>
</p>

<p style='font-family:"Proxima Nova"'>
  <strong style='font-family:"Proxima Nova";font-size: 14px;'>
    Event Date/Time:
  </strong>
  <br style='font-family:"Proxima Nova"'>
  06:00pm - Monday, April 13, 2026 (Eastern Time - US &amp; Canada)
</p>`,
    expect: {
      eventDatetime: { contains: '06:00pm' },
      inviteeEmail: 'twisters42@gmail.com',
      kind: 'tour_scheduled',
    },
  },
  {
    name: 'Calendly Cancel with inline styles',
    from: 'notifications@calendly.com',
    subject: 'Canceled: 10:45am - Wednesday, April 29, 2026 - Rixey Manor Venue Tour',
    body: `<p>
  <strong style='font-size:14px'>Invitee Email:</strong>
  <br style='font-family:Proxima'>
  jane.doe@example.com
</p>
<p>
  <strong style='font-size:14px'>Event Date/Time:</strong>
  <br style='font-family:Proxima'>
  10:45am - Wednesday, April 29, 2026 (Eastern Time - US &amp; Canada)
</p>`,
    expect: {
      eventDatetime: { contains: '10:45am' },
      inviteeEmail: 'jane.doe@example.com',
      kind: 'tour_cancelled',
    },
  },
  {
    name: 'Calendly bare <br> still works',
    from: 'no-reply@calendly.com',
    subject: 'New Event: Sarah Smith - 02:00pm Tue, Jul 2, 2026 - Tour',
    body: `<p>
  <strong>Invitee Email:</strong><br/>
  sarah@example.com
</p>
<p>
  <strong>Event Date/Time:</strong><br/>
  02:00pm - Tuesday, July 2, 2026 (Eastern Time)
</p>`,
    expect: {
      eventDatetime: { contains: '02:00pm' },
      inviteeEmail: 'sarah@example.com',
      kind: 'tour_scheduled',
    },
  },
]

let pass = 0
let fail = 0
for (const c of cases) {
  const result = detectSchedulingEvent({
    from: c.from,
    subject: c.subject,
    body: c.body,
  })
  const fails: string[] = []
  if (!result) {
    fails.push('detection returned null')
  } else {
    if (result.inviteeEmail !== c.expect.inviteeEmail) {
      fails.push(`inviteeEmail "${result.inviteeEmail}" expected "${c.expect.inviteeEmail}"`)
    }
    if (result.kind !== c.expect.kind) {
      fails.push(`kind "${result.kind}" expected "${c.expect.kind}"`)
    }
    const ed = result.eventDatetime ?? ''
    const expEd = c.expect.eventDatetime
    if (typeof expEd === 'string') {
      if (ed !== expEd) fails.push(`eventDatetime "${ed}" expected "${expEd}"`)
    } else {
      if (!ed.includes(expEd.contains)) {
        fails.push(`eventDatetime "${ed}" should contain "${expEd.contains}"`)
      }
    }
    if (/<\/?\w+/.test(ed)) {
      fails.push(`eventDatetime contains HTML tag fragment: "${ed}"`)
    }
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
