/**
 * detectCsvShape() -- the Dubsado / Aisle Planner branches (W53,
 * NOVEMBER-PLAN.md wave 8).
 *
 * This is the header-signature detector the crm-import registry
 * relies on to pick an adapter from a raw CSV upload (see the "Picking
 * an adapter from a header row" section of
 * `src/lib/services/crm-import/index.ts`'s header comment, and
 * `src/lib/services/import-router/route-and-process.ts` for the actual
 * dispatch). Both adapter branches (dubsado / aisleplanner) already
 * existed here from Wave 4 Phase 4c, written ahead of the adapters
 * themselves -- this file is the test coverage that was missing before
 * W53 promoted dubsado.ts / aisleplanner.ts out of scaffold.
 *
 * No AI, no DB -- detectCsvShape is pure string matching over a header
 * row, so these are plain unit tests.
 */

import { describe, it, expect } from 'vitest'
import { detectCsvShape } from '../csv-shape'

describe('detectCsvShape -- dubsado', () => {
  it('recognises the real fixture header used by dubsado.test.ts', () => {
    const headers = [
      'Project Name', 'Client First Name', 'Client Last Name', 'Client Email',
      'Client Phone', 'Project Date', 'Total Invoiced', 'Project Status',
      'Lead Source', 'Date Created', 'Date Booked', 'Internal Notes',
    ]
    const d = detectCsvShape(headers)
    expect(d.shape).toBe('dubsado')
    expect(d.confidence).toBeGreaterThanOrEqual(70)
  })

  it('still recognises a leaner Dubsado export missing several optional columns', () => {
    const headers = ['Client First Name', 'Client Last Name', 'Project Name', 'Project Date']
    const d = detectCsvShape(headers)
    expect(d.shape).toBe('dubsado')
  })

  it('requires the split first/last name pair -- a single "Client Name" column does not match', () => {
    const headers = ['Project Name', 'Client Name', 'Project Date', 'Lead Source']
    const d = detectCsvShape(headers)
    expect(d.shape).not.toBe('dubsado')
  })
})

describe('detectCsvShape -- aisleplanner', () => {
  it('recognises the real fixture header used by aisleplanner.test.ts', () => {
    const headers = [
      'Lead ID', 'Couple', 'Email Address', 'Phone', 'Wedding Date',
      'Estimated Budget', 'Status', 'Lead Source', 'Created', 'Booked Date', 'Notes',
    ]
    const d = detectCsvShape(headers)
    expect(d.shape).toBe('aisleplanner')
    expect(d.confidence).toBeGreaterThanOrEqual(70)
  })

  it('requires the "Couple" column -- separate name columns do not match', () => {
    const headers = ['Lead Name', 'Partner Name', 'Email', 'Wedding Date', 'Status']
    const d = detectCsvShape(headers)
    expect(d.shape).not.toBe('aisleplanner')
  })
})

// ---------------------------------------------------------------------------
// Ambiguity: HoneyBook.
// ---------------------------------------------------------------------------
//
// HoneyBook's own column-acceptance is deliberately wide (it takes
// "Lead Source", "Created Date", "Client Name" as valid variants of its
// own columns -- see honeybook.ts's COLUMNS table), which is exactly
// the overlap that could misroute a Dubsado file into the HoneyBook
// adapter or vice versa. These tests prove the detector's actual
// disambiguation rule: Dubsado's SPLIT "Client First Name" / "Client
// Last Name" pair gates the HoneyBook branch off entirely (see
// csv-shape.ts's own comment on this), so the two can't both claim the
// same header row.

describe('detectCsvShape -- ambiguity against HoneyBook', () => {
  it('a genuine HoneyBook export is never read as Dubsado or Aisle Planner', () => {
    // The real "Booked Client" export shape from
    // honeybook-related-contacts.test.ts.
    const headers = [
      'First Name', 'Last Name', 'Email', 'Project Name', 'Project Type',
      'Project Source', 'Project Creation Date', 'Project Date', 'Booked Date',
      'Total Booked Value', 'Tax', 'Total Paid', 'Refunded Amount', 'Gratuity', 'Company',
    ]
    const d = detectCsvShape(headers)
    expect(d.shape).toBe('honeybook')
  })

  it('a header carrying Dubsado-flavoured columns (Lead Source, Date Created, Project Name) ' +
     'plus a HoneyBook financial/Client-Email column still resolves to HoneyBook, not Dubsado, ' +
     'because it never carries the split first/last name pair', () => {
    const headers = [
      'Project Name', 'Client Email', 'Project Date', 'Lead Source',
      'Project Status', 'Date Created', 'Total',
    ]
    const d = detectCsvShape(headers)
    expect(d.shape).toBe('honeybook')
  })

  it('once the split name pair is present, the same overlapping columns resolve to Dubsado instead', () => {
    const headers = [
      'Project Name', 'Client First Name', 'Client Last Name', 'Client Email',
      'Project Date', 'Lead Source', 'Project Status', 'Date Created', 'Total Invoiced',
    ]
    const d = detectCsvShape(headers)
    expect(d.shape).toBe('dubsado')
  })
})

// ---------------------------------------------------------------------------
// Ambiguity: generic CSV.
// ---------------------------------------------------------------------------

describe('detectCsvShape -- ambiguity against a generic CSV', () => {
  it('an ordinary leads sheet is not misread as Dubsado', () => {
    const headers = ['Name', 'Email', 'Wedding Date', 'Guest Count', 'Notes']
    const d = detectCsvShape(headers)
    expect(d.shape).not.toBe('dubsado')
  })

  it('an ordinary leads sheet is not misread as Aisle Planner', () => {
    const headers = ['Name', 'Email', 'Wedding Date', 'Guest Count', 'Notes']
    const d = detectCsvShape(headers)
    expect(d.shape).not.toBe('aisleplanner')
  })

  it('a couple of unrelated columns match nothing and fall through to unknown/leads, not a CRM adapter', () => {
    const headers = ['First Name', 'Comment', 'Rating']
    const d = detectCsvShape(headers)
    expect(d.shape).not.toBe('dubsado')
    expect(d.shape).not.toBe('aisleplanner')
    expect(d.shape).not.toBe('honeybook')
  })
})
