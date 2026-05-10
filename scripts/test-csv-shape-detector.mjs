#!/usr/bin/env node
// Smoke test for the Wave 4 Phase 4c csv-shape adapter detection.
// Run via: node --import tsx scripts/test-csv-shape-detector.mjs

const { detectCsvShape } = await import('../src/lib/services/brain-dump/csv-shape.ts')

const cases = [
  {
    name: 'HoneyBook (canonical export)',
    headers: [
      'Project Name', 'Project Type', 'Project Date', 'Project Status',
      'Client Name', 'Client Email', 'Client Phone', 'Total', 'Paid',
      'Balance', 'Source', 'Inquiry Date', 'Booking Date', 'Tags', 'Notes',
    ],
    expectShape: 'honeybook',
    expectMinConfidence: 95,
  },
  {
    name: 'HoneyBook (minimal export)',
    headers: ['Project Name', 'Project Date', 'Client Email', 'Project Status', 'Total'],
    expectShape: 'honeybook',
    expectMinConfidence: 70,
  },
  {
    name: 'Aisleplanner',
    headers: [
      'Lead ID', 'Couple', 'Email Address', 'Phone', 'Wedding Date',
      'Estimated Budget', 'Status', 'Source', 'Created', 'Booked Date', 'Notes',
    ],
    expectShape: 'aisleplanner',
    expectMinConfidence: 90,
  },
  {
    name: 'Dubsado',
    headers: [
      'Project Name', 'Client First Name', 'Client Last Name', 'Client Email',
      'Client Phone', 'Project Date', 'Total Invoiced', 'Project Status',
      'Lead Source', 'Date Created', 'Date Booked', 'Internal Notes',
    ],
    expectShape: 'dubsado',
    expectMinConfidence: 90,
  },
  {
    name: 'Tour scheduler (Calendly)',
    headers: [
      'Event Type Name', 'Start Date & Time', 'End Date & Time',
      'Invitee Name', 'Invitee Email', 'Cancelled Reason',
      'UTM Source', 'Question 1', 'Response 1',
    ],
    expectShape: 'tour_scheduler',
    expectMinConfidence: 88,
  },
  {
    name: 'Web form (Typeform-ish)',
    headers: [
      'Submitted At', 'Network ID', 'Name', 'Email', 'Phone',
      "Partner's Name", 'Wedding Date', 'Guest Count', 'Anything else?',
    ],
    expectShape: 'web_form',
    expectMinConfidence: 75,
  },
  {
    name: 'Web form packages (Rixey calculator)',
    headers: [
      'Reference Number', 'Received', 'Partner One Name', 'Partner One Email',
      'Wedding Season (2026/2027)', 'Upgrades', 'After Tax',
      'Total Before Discounts', 'Each Payment',
    ],
    expectShape: 'web_form_packages',
    expectMinConfidence: 78,
  },
  {
    name: 'Generic leads (CRM-shaped, no adapter signature)',
    headers: ['Name', 'Email', 'Wedding Date', 'Guest Count'],
    expectShape: 'leads',
    expectMinConfidence: 70,
  },
  {
    name: 'Platform activity (Knot/WW)',
    headers: ['Action', 'Visitor Name', 'Date', 'City', 'State'],
    expectShape: 'platform_activity',
    expectMinConfidence: 88,
  },
]

let pass = 0
let fail = 0
for (const c of cases) {
  const r = detectCsvShape(c.headers)
  const okShape = r.shape === c.expectShape
  const okConf = r.confidence >= c.expectMinConfidence
  const status = okShape && okConf ? 'PASS' : 'FAIL'
  console.log(
    `${status} ${c.name}: shape=${r.shape} (expected ${c.expectShape}) confidence=${r.confidence} (expected >=${c.expectMinConfidence})`
  )
  if (okShape && okConf) pass++
  else fail++
}

console.log(`\n${pass}/${pass + fail} passed`)
process.exit(fail > 0 ? 1 : 0)
