/**
 * W29 (NOVEMBER-PLAN.md wave 4) — a handle on a CSV row reaches the couple.
 * HANDLE-IDENTITY-SPEC.md §1 + §3.
 *
 * W25 taught the web-form adapter to read an `instagram` column and put the
 * normalised value on `extracted_identity.handles`. It stopped at the
 * interaction row, because this import path commits through `mintWedding` and
 * mirrors the couple afterwards rather than going through `linkSignal`. These
 * tests follow the value the rest of the way: parsed row → `handlesFromRow`
 * → `commitHandleStamps` → `couples.handles`, plus the counts the import
 * summary reports.
 */
import { describe, it, expect } from 'vitest'
import { webFormAdapter } from '../web-form'
import {
  commitHandleStamps,
  firstSeenCandidateFor,
  handlesFromRow,
  type AdapterConfig,
  type NormalisedLeadRow,
} from '../index'
import { FakeSpineDb } from '@/lib/services/__tests__/fake-spine-db'

const CSV = [
  'id,created_at,p1_name,p1_email,wedding_date,guests,instagram',
  '1,2026-06-01,Rosie Hoyle,rosie@example.com,2027-06-20,120,@Rosie.Hoyle',
].join('\n')

async function parseOneWebFormRow(csvText = CSV): Promise<NormalisedLeadRow> {
  const result = await webFormAdapter.parse({
    csvText,
    formProvider: 'calculator_submissions',
  } as AdapterConfig)
  expect(result.ok).toBe(true)
  expect(result.rows).toHaveLength(1)
  return result.rows[0]!
}

describe('handlesFromRow', () => {
  it('reads the handle the web-form adapter put on the row', async () => {
    const row = await parseOneWebFormRow()
    expect(handlesFromRow(row)).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('a row with no handle column yields null, which is the HoneyBook case', async () => {
    const row = await parseOneWebFormRow([
      'id,created_at,p1_name,p1_email,wedding_date,guests',
      '1,2026-06-01,Rosie Hoyle,rosie@example.com,2027-06-20,120',
    ].join('\n'))
    expect(handlesFromRow(row)).toBeNull()
  })

  it('re-normalises whatever the adapter wrote, and drops junk', () => {
    const row = {
      interactions: [
        {
          occurred_at: '2026-06-01T00:00:00.000Z',
          direction: 'inbound' as const,
          type: 'web_form' as const,
          extracted_identity: {
            handles: { instagram: '@Rosie.Hoyle', tiktok: 'not a handle' },
          },
        },
      ],
    } as unknown as NormalisedLeadRow
    expect(handlesFromRow(row)).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('the first interaction to state a platform wins', () => {
    const row = {
      interactions: [
        {
          occurred_at: '2026-06-01T00:00:00.000Z',
          direction: 'inbound' as const,
          type: 'web_form' as const,
          extracted_identity: { handles: { instagram: 'rosie.hoyle' } },
        },
        {
          occurred_at: '2026-07-01T00:00:00.000Z',
          direction: 'inbound' as const,
          type: 'web_form' as const,
          extracted_identity: { handles: { instagram: 'someone.else' } },
        },
      ],
    } as unknown as NormalisedLeadRow
    expect(handlesFromRow(row)).toEqual({ instagram: 'rosie.hoyle' })
  })
})

describe('firstSeenCandidateFor', () => {
  it('takes the earliest usable date on the row', async () => {
    const row = await parseOneWebFormRow()
    expect(firstSeenCandidateFor(row)).toBe(row.interactions![0]!.occurred_at)
  })

  it('returns an empty string when the row carries no date at all', () => {
    const row = { interactions: [] } as unknown as NormalisedLeadRow
    expect(firstSeenCandidateFor(row)).toBe('')
  })
})

describe('commitHandleStamps', () => {
  function seedMirroredCouple(db: FakeSpineDb, handles: unknown = null) {
    db.seed('couples', [
      {
        id: 'couple-1',
        venue_id: 'venue-1',
        source_wedding_id: 'wedding-1',
        handles,
        first_seen_at: null,
      },
    ])
  }

  it('a web-form row ends with couples.handles.instagram set, and the summary counts it', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const row = await parseOneWebFormRow()

    const outcome = await commitHandleStamps({
      supabase: db.client(),
      venueId: 'venue-1',
      pending: [{
        weddingId: 'wedding-1',
        handles: handlesFromRow(row)!,
        occurredAt: firstSeenCandidateFor(row),
        rowSourceId: row.source_id ?? null,
      }],
      survivingWeddings: new Set(['wedding-1']),
    })

    expect(outcome).toEqual({ recorded: 1, conflicts: 0 })
    const couple = db.table('couples')[0]!
    expect(couple.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(couple.first_seen_at).toBe(row.interactions![0]!.occurred_at)
  })

  it('a row whose wedding rolled back stamps nothing', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)

    const outcome = await commitHandleStamps({
      supabase: db.client(),
      venueId: 'venue-1',
      pending: [{
        weddingId: 'wedding-1',
        handles: { instagram: 'rosie.hoyle' },
        occurredAt: '2026-06-01T00:00:00.000Z',
        rowSourceId: null,
      }],
      survivingWeddings: new Set(),
    })

    expect(outcome).toEqual({ recorded: 0, conflicts: 0 })
    expect(db.table('couples')[0]!.handles).toBeNull()
  })

  it('a handle the couple already holds counts nothing, because nothing was recorded', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db, { instagram: 'rosie.hoyle' })

    const outcome = await commitHandleStamps({
      supabase: db.client(),
      venueId: 'venue-1',
      pending: [{
        weddingId: 'wedding-1',
        handles: { instagram: 'rosie.hoyle' },
        occurredAt: '2026-06-01T00:00:00.000Z',
        rowSourceId: null,
      }],
      survivingWeddings: new Set(['wedding-1']),
    })

    expect(outcome).toEqual({ recorded: 0, conflicts: 0 })
    expect(db.table('couples')[0]!.handles).toEqual({ instagram: 'rosie.hoyle' })
  })

  it('a different handle on a held platform is counted as a conflict and never overwrites', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db, { instagram: 'rosie.and.sam' })

    const outcome = await commitHandleStamps({
      supabase: db.client(),
      venueId: 'venue-1',
      pending: [{
        weddingId: 'wedding-1',
        handles: { instagram: 'rosie.hoyle' },
        occurredAt: '2026-06-01T00:00:00.000Z',
        rowSourceId: 'row-7',
      }],
      survivingWeddings: new Set(['wedding-1']),
    })

    expect(outcome).toEqual({ recorded: 0, conflicts: 1 })
    expect(db.table('couples')[0]!.handles).toEqual({ instagram: 'rosie.and.sam' })
    expect(db.table('couple_merge_events')[0]!.event_type).toBe('handle_contradiction')
  })

  it('a row with no mirrored couple is skipped rather than throwing', async () => {
    const db = new FakeSpineDb()
    // No couples row at all, and the mirror will find no wedding either.
    const outcome = await commitHandleStamps({
      supabase: db.client(),
      venueId: 'venue-1',
      pending: [{
        weddingId: 'wedding-missing',
        handles: { instagram: 'rosie.hoyle' },
        occurredAt: '2026-06-01T00:00:00.000Z',
        rowSourceId: null,
      }],
      survivingWeddings: new Set(['wedding-missing']),
    })
    expect(outcome).toEqual({ recorded: 0, conflicts: 0 })
  })
})
