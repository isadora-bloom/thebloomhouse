/**
 * Aisle Planner adapter (W53, NOVEMBER-PLAN.md wave 8).
 *
 * Mirrors the shape of honeybook-related-contacts.test.ts (parse
 * only, no network/DB) plus the row-on-the-spine coverage from
 * crm-import-handles.test.ts (buildRowSignals/commitRowSignals against
 * FakeSpineDb) -- dedup by email, one couple per row, venue isolation.
 *
 * Fixture provenance: src/lib/services/crm-import/__tests__/fixtures/
 * aisleplanner-leads.csv, header comment there.
 */

import { describe, it, expect } from 'vitest'
import { aislePlannerAdapter } from '../aisleplanner'
import { loadFixtureCsv } from './load-fixture'
import {
  buildRowSignals,
  commitRowSignals,
  findSpineCoupleWedding,
} from '../row-signals'
import { firstSeenCandidateFor, handlesFromRow } from '../index'
import { FakeSpineDb } from '@/lib/services/__tests__/fake-spine-db'

const FIXTURE = loadFixtureCsv('aisleplanner-leads.csv')

async function parse() {
  const res = await aislePlannerAdapter.parse({ csvText: FIXTURE })
  expect(res.ok).toBe(true)
  return res
}

describe('aisle planner adapter -- parse', () => {
  it('is no longer scaffold-only', () => {
    expect(aislePlannerAdapter.ready).toBe(true)
  })

  it('parses every row in the fixture', async () => {
    const res = await parse()
    expect(res.rows).toHaveLength(6)
  })

  it('splits a comma-joined Couple cell into two partners', async () => {
    const res = await parse()
    const naomi = res.rows.find((r) => r.source_id === 'AP-1001')!
    expect(naomi.partner1_first_name).toBe('Naomi')
    expect(naomi.partner1_last_name).toBe('Okonkwo')
    expect(naomi.partner2_first_name).toBe('Daniel')
    expect(naomi.partner2_last_name).toBe('Okonkwo-Reyes')
    // The row-level Email Address / Phone columns back-fill partner1
    // when the Couple cell itself carried no embedded contact detail.
    expect(naomi.partner1_email).toBe('naomi.okonkwo@example.com')
    expect(naomi.partner1_phone).toBe('555-0161')
  })

  it('collapses a shared-surname "&" Couple cell into two partners', async () => {
    const res = await parse()
    const petra = res.rows.find((r) => r.source_id === 'AP-1004')!
    expect(petra.partner1_first_name).toBe('Petra')
    expect(petra.partner1_last_name).toBe('Vance')
    expect(petra.partner2_first_name).toBe('Simon')
    expect(petra.partner2_last_name).toBe('Vance')
  })

  it('leaves partner2 empty for a single-name Couple cell', async () => {
    const res = await parse()
    const freya = res.rows.find((r) => r.source_id === 'AP-1002')!
    expect(freya.partner1_first_name).toBe('Freya')
    expect(freya.partner1_last_name).toBe('Lindqvist')
    expect(freya.partner2_first_name).toBeNull()
  })

  it('maps the Aisle Planner status vocabulary, including "On Hold" -> inquiry', async () => {
    const res = await parse()
    const bySourceId = (id: string) => res.rows.find((r) => r.source_id === id)!
    expect(bySourceId('AP-1001').status).toBe('booked')     // Booked
    expect(bySourceId('AP-1002').status).toBe('inquiry')    // New
    expect(bySourceId('AP-1003').status).toBe('inquiry')    // In Progress
    expect(bySourceId('AP-1004').status).toBe('completed')  // Completed
    expect(bySourceId('AP-1005').status).toBe('lost')       // Lost
    expect(bySourceId('AP-1006').status).toBe('inquiry')    // On Hold
  })

  it('notes an On Hold status rather than dropping it silently', async () => {
    const res = await parse()
    const marisol = res.rows.find((r) => r.source_id === 'AP-1006')!
    expect(marisol.notes).toContain('On Hold')
  })

  it('creates a lost_deal row only for a lost status', async () => {
    const res = await parse()
    const aoife = res.rows.find((r) => r.source_id === 'AP-1005')!
    expect(aoife.lost_deal).not.toBeNull()
    expect(aoife.lost_deal!.reason_category).toBe('other')

    const petra = res.rows.find((r) => r.source_id === 'AP-1004')!
    expect(petra.lost_deal).toBeNull()
  })

  it('puts Estimated Budget into notes, never into booking_value', async () => {
    const res = await parse()
    const naomi = res.rows.find((r) => r.source_id === 'AP-1001')!
    expect(naomi.booking_value).toBeFalsy()
    expect(naomi.notes).toContain('Estimated budget')
    expect(naomi.notes).toContain('$25,000.00')
    // The row's own free-text notes column is preserved alongside it.
    expect(naomi.notes).toContain('Wants a Saturday evening ceremony.')
  })

  it('writes Lead Source verbatim into source_detail and NEVER interprets it, and leaves the weddings source column null', async () => {
    const res = await parse()
    const aoife = res.rows.find((r) => r.source_id === 'AP-1005')!
    expect(aoife.source_detail).toBe('The Knot')
    expect(aoife.source).toBeNull()

    const marisol = res.rows.find((r) => r.source_id === 'AP-1006')!
    expect(marisol.source_detail).toBe('Unknown')
    expect(marisol.source).toBeNull()

    for (const row of res.rows) expect(row.source).toBeNull()
  })

  it('fails with a clear error when a required column is missing', async () => {
    const csv = ['Lead ID,Email Address,Status', 'AP-9,a@example.com,New'].join('\n')
    const res = await aislePlannerAdapter.parse({ csvText: csv })
    expect(res.ok).toBe(false)
    expect(res.errors[0]).toContain('Couple')
  })
})

describe('aisle planner adapter -- preview', () => {
  it('summarises status counts and flags rows with a second partner', async () => {
    const res = await parse()
    const preview = aislePlannerAdapter.preview(res.rows)
    expect(preview.total).toBe(6)
    const joined = preview.warnings.join(' | ')
    expect(joined).toContain('booked=1')
    expect(joined).toContain('lost=1')
    expect(joined).toContain('had a second partner in the Couple cell')
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
      primary_contact_name: 'Naomi Okonkwo',
      primary_contact_email: 'naomi.okonkwo@example.com',
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
  const row = res.rows.find((r) => r.source_id === 'AP-1001')!
  return {
    row,
    signals: buildRowSignals({
      row,
      crmSource: 'aisle_planner',
      weddingId,
      interactions: row.interactions ?? [],
      handles: handlesFromRow(row),
      rowOccurredAt: firstSeenCandidateFor(row),
    }),
  }
}

describe('aisle planner adapter -- one couple per row, through the fake spine', () => {
  it('an Aisle Planner row lands on exactly one couple', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const { row, signals } = await firstRowSignals()

    const summary = await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'aisle_planner',
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
      crmSource: 'aisle_planner' as const,
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

  it('matches the stored spelling of the email whichever case the row used', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db, { primary_contact_email: 'naomi.okonkwo@example.com' })
    const found = await findSpineCoupleWedding({
      supabase: db.client(),
      venueId: 'venue-1',
      email: 'Naomi.Okonkwo@Example.com',
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
      email: 'naomi.okonkwo@example.com',
      phone: null,
    })
    expect(found).toBeNull()

    const { row, signals } = await firstRowSignals()
    await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'aisle_planner',
      pending: [{ weddingId: 'wedding-1', rowSourceId: row.source_id ?? null, signals }],
      survivingWeddings: new Set(['wedding-1']),
    })
    expect(db.table('couples').filter((c) => c.venue_id === 'venue-2')).toHaveLength(0)
  })
})
