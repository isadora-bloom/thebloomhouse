/**
 * Dubsado adapter (W53, NOVEMBER-PLAN.md wave 8).
 *
 * Mirrors the shape of honeybook-related-contacts.test.ts (parse
 * only, no network/DB) plus the row-on-the-spine coverage from
 * crm-import-handles.test.ts (buildRowSignals/commitRowSignals against
 * FakeSpineDb) -- dedup by email, one couple per row, venue isolation.
 *
 * Fixture provenance: src/lib/services/crm-import/__tests__/fixtures/
 * dubsado-projects.csv, header comment there.
 */

import { describe, it, expect } from 'vitest'
import { dubsadoAdapter } from '../dubsado'
import { loadFixtureCsv } from './load-fixture'
import {
  buildRowSignals,
  commitRowSignals,
  findSpineCoupleWedding,
} from '../row-signals'
import { firstSeenCandidateFor, handlesFromRow } from '../index'
import { FakeSpineDb } from '@/lib/services/__tests__/fake-spine-db'

const FIXTURE = loadFixtureCsv('dubsado-projects.csv')

async function parse() {
  const res = await dubsadoAdapter.parse({ csvText: FIXTURE })
  expect(res.ok).toBe(true)
  return res
}

describe('dubsado adapter -- parse', () => {
  it('is no longer scaffold-only', () => {
    expect(dubsadoAdapter.ready).toBe(true)
  })

  it('parses every row in the fixture', async () => {
    const res = await parse()
    expect(res.rows).toHaveLength(6)
  })

  it('maps client + project fields onto the row', async () => {
    const res = await parse()
    const rosalind = res.rows.find((r) => r.partner1_email === 'rosalind.fairweather@example.com')!
    expect(rosalind.partner1_first_name).toBe('Rosalind')
    expect(rosalind.partner1_last_name).toBe('Fairweather')
    expect(rosalind.partner1_phone).toBe('555-0142')
    expect(rosalind.wedding_date).toBe('2027-05-15')
    expect(rosalind.booking_value).toBe(1_850_000)
    expect(rosalind.notes).toBe('Wants a marquee on the east lawn.')
  })

  it('derives partner2 from a joint project name, inheriting the shared surname', async () => {
    const res = await parse()
    const rosalind = res.rows.find((r) => r.partner1_email === 'rosalind.fairweather@example.com')!
    expect(rosalind.partner2_first_name).toBe('Tom')
    expect(rosalind.partner2_last_name).toBe('Fairweather')

    const deja = res.rows.find((r) => r.partner1_email === 'deja.okafor@example.com')!
    expect(deja.partner2_first_name).toBe('Marcus')
    expect(deja.partner2_last_name).toBe('Okafor')
  })

  it('leaves partner2 empty when the project was named after one person', async () => {
    const res = await parse()
    const priya = res.rows.find((r) => r.partner1_email === 'priya.nair@example.com')!
    expect(priya.partner2_first_name).toBeNull()
    expect(priya.partner2_last_name).toBeNull()

    // "Test Client Wedding" must not double-count Client First/Last as
    // a second partner -- the project name carries no "&"/"and".
    const test = res.rows.find((r) => r.partner1_email === 'test.client@example.com')!
    expect(test.partner2_first_name).toBeNull()
  })

  it('maps the Dubsado status vocabulary through the shared lifecycle mapping', async () => {
    const res = await parse()
    const byEmail = (email: string) => res.rows.find((r) => r.partner1_email === email)!
    expect(byEmail('rosalind.fairweather@example.com').status).toBe('booked') // Active
    expect(byEmail('priya.nair@example.com').status).toBe('inquiry')          // Lead
    expect(byEmail('deja.okafor@example.com').status).toBe('lost')            // Archived
    expect(byEmail('holly.vance@example.com').status).toBe('completed')       // Completed
    expect(byEmail('grace.pemberton@example.com').status).toBe('lost')        // Lost
    expect(byEmail('test.client@example.com').status).toBe('booked')          // Won
  })

  it('creates a lost_deal row for a lost/archived status, and only then', async () => {
    const res = await parse()
    const deja = res.rows.find((r) => r.partner1_email === 'deja.okafor@example.com')!
    expect(deja.lost_deal).not.toBeNull()
    expect(deja.lost_deal!.reason_category).toBe('other')

    const rosalind = res.rows.find((r) => r.partner1_email === 'rosalind.fairweather@example.com')!
    expect(rosalind.lost_deal).toBeNull()
  })

  it('writes Lead Source verbatim into source_detail and NEVER interprets it, and leaves the weddings source column null', async () => {
    const res = await parse()
    // "The Knot" is a recognisable channel name -- and must still land
    // untouched in source_detail with the weddings source column left null. This
    // is the adapter contract's explicit "never interpreted" rule.
    const test = res.rows.find((r) => r.partner1_email === 'test.client@example.com')!
    expect(test.source_detail).toBe('The Knot')
    expect(test.source).toBeNull()

    const grace = res.rows.find((r) => r.partner1_email === 'grace.pemberton@example.com')!
    expect(grace.source_detail).toBe('Unknown')
    expect(grace.source).toBeNull()

    // Every row in the fixture: source stays null.
    for (const row of res.rows) expect(row.source).toBeNull()
  })

  it('handles a blank Total Invoiced / Booked Date without throwing', async () => {
    const res = await parse()
    const priya = res.rows.find((r) => r.partner1_email === 'priya.nair@example.com')!
    expect(priya.booking_value).toBeNull()
    expect(priya.booked_at).toBeNull()
  })

  it('preserves the full source row for unmapped columns', async () => {
    const res = await parse()
    const rosalind = res.rows.find((r) => r.partner1_email === 'rosalind.fairweather@example.com')!
    expect(rosalind.raw_row).toMatchObject({ 'Project Status': 'Active' })
  })

  it('fails with a clear error when a required column is missing', async () => {
    const csv = ['Client First Name,Client Last Name,Client Email', 'A,B,a@example.com'].join('\n')
    const res = await dubsadoAdapter.parse({ csvText: csv })
    expect(res.ok).toBe(false)
    expect(res.errors[0]).toContain('Project Date')
  })

  it('accepts the less-common single "Client Name" column shape', async () => {
    const csv = [
      'Project Name,Client Name,Client Email,Project Date,Project Status',
      'Simone Ward Wedding,Simone Ward,simone@example.com,2027-03-01,Lead',
    ].join('\n')
    const res = await dubsadoAdapter.parse({ csvText: csv })
    expect(res.ok).toBe(true)
    expect(res.rows[0]!.partner1_first_name).toBe('Simone')
    expect(res.rows[0]!.partner1_last_name).toBe('Ward')
  })
})

describe('dubsado adapter -- preview', () => {
  it('summarises status counts and flags rows with a derived partner2', async () => {
    const res = await parse()
    const preview = dubsadoAdapter.preview(res.rows)
    expect(preview.total).toBe(6)
    const joined = preview.warnings.join(' | ')
    expect(joined).toContain('booked=2')
    expect(joined).toContain('lost=2')
    expect(joined).toContain('read a second partner from the project name')
  })
})

// ---------------------------------------------------------------------------
// Row on the spine: dedup by email, one couple per row, venue isolation.
// Mirrors crm-import-handles.test.ts's `commitRowSignals` block.
// ---------------------------------------------------------------------------

function seedMirroredCouple(db: FakeSpineDb, overrides: Record<string, unknown> = {}) {
  db.seed('couples', [
    {
      id: 'couple-1',
      venue_id: 'venue-1',
      source_wedding_id: 'wedding-1',
      primary_contact_name: 'Rosalind Fairweather',
      primary_contact_email: 'rosalind.fairweather@example.com',
      handles: null,
      first_seen_at: null,
      point_zero_at: null,
      merged_into_id: null,
      ...overrides,
    },
  ])
}

async function firstRowSignals(weddingId = 'wedding-1') {
  const res = await parse()
  const row = res.rows.find((r) => r.partner1_email === 'rosalind.fairweather@example.com')!
  return {
    row,
    signals: buildRowSignals({
      row,
      crmSource: 'dubsado',
      weddingId,
      interactions: row.interactions ?? [],
      handles: handlesFromRow(row),
      rowOccurredAt: firstSeenCandidateFor(row),
    }),
  }
}

describe('dubsado adapter -- one couple per row, through the fake spine', () => {
  it('a Dubsado row lands on exactly one couple', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const { row, signals } = await firstRowSignals()

    const summary = await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'dubsado',
      pending: [{ weddingId: 'wedding-1', rowSourceId: row.source_id ?? null, signals }],
      survivingWeddings: new Set(['wedding-1']),
    })

    expect(summary.minted).toBe(0)
    expect(summary.skipped).toEqual([])
    expect(db.table('couples')).toHaveLength(1)
    expect(db.table('couples')[0]!.id).toBe('couple-1')
  })

  it('a second import of the same file (dedup by external id) changes nothing', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const { row, signals } = await firstRowSignals()
    const args = {
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'dubsado' as const,
      pending: [{ weddingId: 'wedding-1', rowSourceId: row.source_id ?? null, signals }],
      survivingWeddings: new Set(['wedding-1']),
    }
    await commitRowSignals(args)
    const afterFirst = JSON.stringify(db.table('couples'))

    const second = await firstRowSignals()
    const rerun = await commitRowSignals({
      ...args,
      pending: [{ weddingId: 'wedding-1', rowSourceId: second.row.source_id ?? null, signals: second.signals }],
    })

    expect(rerun.duplicate).toBe(second.signals.length)
    expect(rerun.attached).toBe(0)
    expect(db.table('couples')).toHaveLength(1)
    expect(JSON.stringify(db.table('couples'))).toBe(afterFirst)
  })

  it('dedup is keyed on the row identity (email/name), not the row\'s cell contents', async () => {
    // findSpineCoupleWedding matches on email regardless of case --
    // the same de-dup guarantee every adapter shares.
    const db = new FakeSpineDb()
    seedMirroredCouple(db, { primary_contact_email: 'rosalind.fairweather@example.com' })
    const found = await findSpineCoupleWedding({
      supabase: db.client(),
      venueId: 'venue-1',
      email: 'Rosalind.Fairweather@Example.com',
      phone: null,
    })
    expect(found).toBe('wedding-1')
  })

  it('never reaches across venues', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const found = await findSpineCoupleWedding({
      supabase: db.client(),
      venueId: 'venue-2',
      email: 'rosalind.fairweather@example.com',
      phone: null,
    })
    expect(found).toBeNull()

    // The row-signals channel is venue-agnostic by construction, but
    // the commit only ever runs inside one venueId -- assert a second
    // venue's spine is untouched by this venue's commit.
    const { row, signals } = await firstRowSignals()
    await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'dubsado',
      pending: [{ weddingId: 'wedding-1', rowSourceId: row.source_id ?? null, signals }],
      survivingWeddings: new Set(['wedding-1']),
    })
    expect(db.table('couples').filter((c) => c.venue_id === 'venue-2')).toHaveLength(0)
  })
})
