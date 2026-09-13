/**
 * A CSV row reaches the couple through the one writer.
 * W29 started this (HANDLE-IDENTITY-SPEC.md §1 + §3); W35 finished it by
 * putting the import on `linkSignal` instead of a second pass.
 *
 * The first two blocks are the pure readers that turn an adapter's row
 * shape into the two fields a signal needs: the handles it carries and the
 * earliest date it knows about. They are unchanged by W35 and still tested
 * the same way. The rest follows the value the rest of the way: parsed row
 * → `buildRowSignals` → `commitRowSignals` → `linkSignal` → couples.handles
 * and couples.first_seen_at, plus the counts the import summary reports.
 */
import { describe, it, expect } from 'vitest'
import { webFormAdapter } from '../web-form'
import {
  firstSeenCandidateFor,
  handlesFromRow,
  type AdapterConfig,
  type NormalisedLeadRow,
} from '../index'
import {
  buildRowSignals,
  commitRowSignals,
  findSpineCoupleWedding,
} from '../row-signals'
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

// ---------------------------------------------------------------------------
// W35: the row on the one writer
// ---------------------------------------------------------------------------

async function webFormSignals(weddingId = 'wedding-1') {
  const row = await parseOneWebFormRow()
  return {
    row,
    signals: buildRowSignals({
      row,
      crmSource: 'web_form',
      weddingId,
      interactions: row.interactions ?? [],
      handles: handlesFromRow(row),
      rowOccurredAt: firstSeenCandidateFor(row),
    }),
  }
}

function seedMirroredCouple(db: FakeSpineDb, overrides: Record<string, unknown> = {}) {
  db.seed('couples', [
    {
      id: 'couple-1',
      venue_id: 'venue-1',
      source_wedding_id: 'wedding-1',
      primary_contact_name: 'Rosie Hoyle',
      primary_contact_email: 'rosie@example.com',
      handles: null,
      first_seen_at: null,
      point_zero_at: null,
      merged_into_id: null,
      ...overrides,
    },
  ])
}

describe('buildRowSignals', () => {
  it('a web-form row produces a row anchor plus one signal per interaction', async () => {
    const { row, signals } = await webFormSignals()
    expect(signals).toHaveLength(1 + (row.interactions?.length ?? 0))
    expect(signals.every((s) => s.channel === 'web')).toBe(true)
    expect(signals.every((s) => s.legacy_wedding_id === 'wedding-1')).toBe(true)
    const anchor = signals.find((s) => s.external_id.endsWith(':row'))!
    expect(anchor.action_type).toBe('crm_imported_inquiry')
    expect(anchor.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(anchor.primary_email).toBe('rosie@example.com')
    expect(anchor.occurred_at).toBe(firstSeenCandidateFor(row))
    const formSignal = signals.find((s) => s.action_type === 'crm_form_submit')
    expect(formSignal).toBeTruthy()
  })

  it('the external ids are a pure function of the file, so a re-parse repeats them', async () => {
    const a = await webFormSignals()
    const b = await webFormSignals()
    expect(b.signals.map((s) => s.external_id))
      .toEqual(a.signals.map((s) => s.external_id))
  })

  it('signals come back earliest first', () => {
    const row = {
      status: 'booked' as const,
      partner1_first_name: 'Rosie',
      partner1_email: 'rosie@example.com',
      inquiry_date: '2026-01-01T00:00:00.000Z',
      interactions: [
        {
          occurred_at: '2026-05-01T00:00:00.000Z',
          direction: 'inbound' as const,
          type: 'email' as const,
        },
        {
          occurred_at: '2026-03-01T00:00:00.000Z',
          direction: 'outbound' as const,
          type: 'email' as const,
        },
      ],
    } as unknown as NormalisedLeadRow
    const signals = buildRowSignals({
      row,
      crmSource: 'honeybook',
      weddingId: 'wedding-1',
      interactions: row.interactions ?? [],
      handles: null,
      rowOccurredAt: firstSeenCandidateFor(row),
    })
    const times = signals.map((s) => Date.parse(s.occurred_at))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(signals[0]!.action_type).toBe('crm_imported_booked')
    expect(signals[1]!.action_type).toBe('crm_email_outbound')
    expect(signals[2]!.action_type).toBe('crm_email_inbound')
  })

  it('a row with no interactions still produces its anchor', () => {
    const row = {
      partner1_first_name: 'Rosie',
      partner1_email: 'rosie@example.com',
      inquiry_date: '2026-01-01T00:00:00.000Z',
      interactions: [],
    } as unknown as NormalisedLeadRow
    const signals = buildRowSignals({
      row,
      crmSource: 'generic_csv',
      weddingId: 'wedding-1',
      interactions: [],
      handles: null,
      rowOccurredAt: firstSeenCandidateFor(row),
    })
    expect(signals).toHaveLength(1)
    expect(signals[0]!.channel).toBe('csv_import')
    expect(signals[0]!.occurred_at).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('findSpineCoupleWedding', () => {
  it('returns the legacy wedding of a couple the spine already holds', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const found = await findSpineCoupleWedding({
      supabase: db.client(),
      venueId: 'venue-1',
      email: 'rosie@example.com',
      phone: null,
    })
    expect(found).toBe('wedding-1')
  })

  it('matches the stored spelling of the email whichever case the row used', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db, { primary_contact_email: 'rosie@example.com' })
    const found = await findSpineCoupleWedding({
      supabase: db.client(),
      venueId: 'venue-1',
      email: 'Rosie@Example.com',
      phone: null,
    })
    expect(found).toBe('wedding-1')
  })

  it('leaves a channel-scoped couple alone, because it has no wedding to import onto', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db, { source_wedding_id: null })
    const found = await findSpineCoupleWedding({
      supabase: db.client(),
      venueId: 'venue-1',
      email: 'rosie@example.com',
      phone: null,
    })
    expect(found).toBeNull()
  })

  it('never reaches across venues', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const found = await findSpineCoupleWedding({
      supabase: db.client(),
      venueId: 'venue-2',
      email: 'rosie@example.com',
      phone: null,
    })
    expect(found).toBeNull()
  })
})

describe('commitRowSignals', () => {
  it('a web-form row lands on one couple with its handle and its first-seen', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const { row, signals } = await webFormSignals()

    const summary = await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'web_form',
      pending: [{ weddingId: 'wedding-1', rowSourceId: row.source_id ?? null, signals }],
      survivingWeddings: new Set(['wedding-1']),
    })

    expect(summary.sent).toBe(signals.length)
    expect(summary.attached).toBe(signals.length)
    expect(summary.minted).toBe(0)
    expect(summary.handlesRecorded).toBe(1)
    expect(summary.handleConflicts).toBe(0)
    expect(summary.skipped).toEqual([])

    expect(db.table('couples')).toHaveLength(1)
    const couple = db.table('couples')[0]!
    expect(couple.handles).toEqual({ instagram: 'rosie.hoyle' })
    expect(couple.first_seen_at).toBe(row.interactions![0]!.occurred_at)
    expect(db.table('touchpoints')).toHaveLength(signals.length)
  })

  it('a second import of the same file changes nothing', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const { row, signals } = await webFormSignals()
    const pending = [{
      weddingId: 'wedding-1', rowSourceId: row.source_id ?? null, signals,
    }]
    const args = {
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'web_form' as const,
      pending,
      survivingWeddings: new Set(['wedding-1']),
    }

    await commitRowSignals(args)
    const afterFirst = {
      couples: JSON.stringify(db.table('couples')),
      touchpoints: db.table('touchpoints').length,
    }

    // The same file, parsed again, produces the same external ids.
    const second = await webFormSignals()
    const rerun = await commitRowSignals({
      ...args,
      pending: [{
        weddingId: 'wedding-1',
        rowSourceId: second.row.source_id ?? null,
        signals: second.signals,
      }],
    })

    expect(rerun.duplicate).toBe(second.signals.length)
    expect(rerun.attached).toBe(0)
    expect(rerun.handlesRecorded).toBe(0)
    expect(rerun.handleConflicts).toBe(0)
    expect(db.table('couples')).toHaveLength(1)
    expect(JSON.stringify(db.table('couples'))).toBe(afterFirst.couples)
    expect(db.table('touchpoints')).toHaveLength(afterFirst.touchpoints)
  })

  it('a HoneyBook row whose couple already exists attaches instead of minting', async () => {
    const db = new FakeSpineDb()
    // The couple is already on the spine, mirrored from an earlier wedding.
    seedMirroredCouple(db, {
      id: 'couple-1',
      primary_contact_name: 'Dana Reyes',
      primary_contact_email: 'dana@example.com',
      first_seen_at: '2026-04-01T00:00:00.000Z',
    })
    const row = {
      source_id: 'Dana and Sam',
      partner1_first_name: 'Dana',
      partner1_last_name: 'Reyes',
      partner1_email: 'dana@example.com',
      status: 'booked' as const,
      inquiry_date: '2026-02-01T00:00:00.000Z',
      interactions: [{
        occurred_at: '2026-03-01T00:00:00.000Z',
        direction: 'inbound' as const,
        type: 'email' as const,
      }],
    } as unknown as NormalisedLeadRow

    const summary = await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'honeybook',
      pending: [{
        weddingId: 'wedding-1',
        rowSourceId: row.source_id ?? null,
        signals: buildRowSignals({
          row,
          crmSource: 'honeybook',
          weddingId: 'wedding-1',
          interactions: row.interactions ?? [],
          handles: null,
          rowOccurredAt: firstSeenCandidateFor(row),
        }),
      }],
      survivingWeddings: new Set(['wedding-1']),
    })

    expect(summary.minted).toBe(0)
    expect(summary.attached).toBe(2)
    expect(db.table('couples')).toHaveLength(1)
    expect(db.table('couples')[0]!.id).toBe('couple-1')
    // first_seen_at moved back to the CRM's inquiry date.
    expect(db.table('couples')[0]!.first_seen_at).toBe('2026-02-01T00:00:00.000Z')
  })

  it('a row whose wedding rolled back links nothing', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db)
    const { row, signals } = await webFormSignals()

    const summary = await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'web_form',
      pending: [{ weddingId: 'wedding-1', rowSourceId: row.source_id ?? null, signals }],
      survivingWeddings: new Set(),
    })

    expect(summary.sent).toBe(0)
    expect(summary.skipped).toEqual([
      { row: row.source_id ?? 'wedding-1', reason: 'wedding_row_rolled_back' },
    ])
    expect(db.table('touchpoints')).toHaveLength(0)
    expect(db.table('couples')[0]!.handles).toBeNull()
  })

  it('a handle the couple already holds records nothing and never overwrites', async () => {
    const db = new FakeSpineDb()
    seedMirroredCouple(db, { handles: { instagram: 'rosie.and.sam' } })
    const { row, signals } = await webFormSignals()

    const summary = await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'web_form',
      pending: [{ weddingId: 'wedding-1', rowSourceId: row.source_id ?? null, signals }],
      survivingWeddings: new Set(['wedding-1']),
    })

    expect(summary.handlesRecorded).toBe(0)
    expect(summary.handleConflicts).toBe(1)
    expect(db.table('couples')[0]!.handles).toEqual({ instagram: 'rosie.and.sam' })
    expect(db.table('couple_merge_events')[0]!.event_type).toBe('handle_contradiction')
  })

  it('a wedding with no mirrored couple is named as skipped, not silently dropped', async () => {
    const db = new FakeSpineDb()
    const summary = await commitRowSignals({
      supabase: db.client(),
      venueId: 'venue-1',
      crmSource: 'web_form',
      pending: [{
        weddingId: 'wedding-missing',
        rowSourceId: 'row-7',
        signals: buildRowSignals({
          row: {
            partner1_email: 'nobody@example.com',
            inquiry_date: '2026-01-01T00:00:00.000Z',
            interactions: [],
          } as unknown as NormalisedLeadRow,
          crmSource: 'web_form',
          weddingId: 'wedding-missing',
          interactions: [],
          handles: null,
          rowOccurredAt: '2026-01-01T00:00:00.000Z',
        }),
      }],
      survivingWeddings: new Set(['wedding-missing']),
    })

    expect(summary.sent).toBe(0)
    expect(summary.skipped).toHaveLength(1)
    expect(summary.skipped[0]!.reason).toBe('no_mirrored_couple')
    expect(db.table('touchpoints')).toHaveLength(0)
  })
})
