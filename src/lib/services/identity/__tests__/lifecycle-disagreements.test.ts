/**
 * The disagreement audit, on a fake client. W37.
 *
 * No database: the reader takes its Supabase client as an argument for
 * exactly this reason, the same dependency seam `loadCoupleJourney` uses.
 * What is being pinned here is the counting and the ordering, not the
 * mapping, which has its own fixture in
 * `src/lib/services/lifecycle/__tests__/vocabulary.test.ts`.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadLifecycleDisagreements } from '../lifecycle-disagreements'

const VENUE = 'venue-1'
const NOW = new Date('2026-09-12T12:00:00.000Z')

interface FakeCouple {
  id: string
  primary_contact_name: string | null
  primary_contact_email: string | null
  lifecycle_state: string | null
  merged_into_id: string | null
  source_wedding_id: string | null
  wedding_date: string | null
  last_progression_at: string | null
}

interface FakeWedding {
  id: string
  lifecycle_stage: string | null
  booked_at: string | null
  status: string | null
  wedding_date: string | null
}

/**
 * The smallest thing that behaves like the query builder the reader uses:
 * `.select().eq().limit()` and `.select().eq().in()`, both awaited. Filters
 * are honoured so a venue-scoping mistake would show up as an empty report
 * rather than as a pass.
 */
function fakeClient(couples: FakeCouple[], weddings: FakeWedding[]): SupabaseClient {
  const rowsFor = (table: string): Array<Record<string, unknown>> =>
    table === 'couples'
      ? (couples as unknown as Array<Record<string, unknown>>)
      : table === 'weddings'
        ? (weddings as unknown as Array<Record<string, unknown>>)
        : []

  const builder = (table: string) => {
    let rows = rowsFor(table)
    const chain = {
      select: () => chain,
      eq: (column: string, value: unknown) => {
        // venue_id is not on the fixtures; the fixtures ARE the venue.
        if (column === 'venue_id') return chain
        rows = rows.filter((r) => r[column] === value)
        return chain
      },
      in: (column: string, values: unknown[]) => {
        rows = rows.filter((r) => values.includes(r[column]))
        return chain
      },
      limit: (n: number) => {
        rows = rows.slice(0, n)
        return chain
      },
      then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
        Promise.resolve({ data: rows, error: null }).then(resolve),
    }
    return chain
  }

  return { from: (table: string) => builder(table) } as unknown as SupabaseClient
}

function couple(partial: Partial<FakeCouple> & { id: string }): FakeCouple {
  return {
    primary_contact_name: partial.id,
    primary_contact_email: null,
    lifecycle_state: null,
    merged_into_id: null,
    source_wedding_id: null,
    wedding_date: null,
    last_progression_at: null,
    ...partial,
  }
}

function wedding(partial: Partial<FakeWedding> & { id: string }): FakeWedding {
  return {
    lifecycle_stage: null,
    booked_at: null,
    status: null,
    wedding_date: null,
    ...partial,
  }
}

describe('loadLifecycleDisagreements', () => {
  it('reports nothing for a venue with no couples', async () => {
    const report = await loadLifecycleDisagreements(fakeClient([], []), VENUE, NOW)
    expect(report.rows).toEqual([])
    expect(report.counts.couplesScanned).toBe(0)
    expect(report.truncated).toBe(false)
  })

  it('refuses to guess without a venue', async () => {
    const report = await loadLifecycleDisagreements(
      fakeClient([couple({ id: 'a' })], []),
      '',
      NOW,
    )
    expect(report.counts.couplesScanned).toBe(0)
  })

  it('puts the spine state, the machine stage and the derived stage side by side', async () => {
    const report = await loadLifecycleDisagreements(
      fakeClient(
        [
          couple({
            id: 'quiet-but-nurtured',
            lifecycle_state: 'ghost',
            source_wedding_id: 'w1',
            last_progression_at: '2026-03-01T00:00:00.000Z',
          }),
        ],
        [wedding({ id: 'w1', lifecycle_stage: 'nurture' })],
      ),
      VENUE,
      NOW,
    )
    const row = report.rows[0]
    expect(row.spineState).toBe('ghost')
    expect(row.machineStage).toBe('nurture')
    expect(row.projectedSpineState).toBe('resolved')
    expect(row.operatorStage).toBe('gone_quiet')
    expect(row.agreement).toBe('disagreed')
    expect(row.because).toContain('pipeline')
  })

  it('counts agreed, disagreed and one-sided, and the shape of each disagreement', async () => {
    const report = await loadLifecycleDisagreements(
      fakeClient(
        [
          couple({ id: 'agrees', lifecycle_state: 'resolved', source_wedding_id: 'w1' }),
          couple({ id: 'disagrees', lifecycle_state: 'ghost', source_wedding_id: 'w2' }),
          couple({ id: 'no-wedding', lifecycle_state: 'resolved' }),
          couple({ id: 'no-state', source_wedding_id: 'w3' }),
        ],
        [
          wedding({ id: 'w1', lifecycle_stage: 'nurture' }),
          wedding({ id: 'w2', lifecycle_stage: 'tour_scheduled' }),
          wedding({ id: 'w3', lifecycle_stage: 'nurture' }),
        ],
      ),
      VENUE,
      NOW,
    )
    expect(report.counts.couplesScanned).toBe(4)
    expect(report.counts.agreed).toBe(1)
    expect(report.counts.disagreed).toBe(1)
    expect(report.counts.oneSided).toBe(2)
    expect(report.counts.noMachineStage).toBe(1)
    expect(report.counts.noSpineState).toBe(1)
    expect(report.counts.byDisagreementPair).toEqual({ 'ghost -> tour_scheduled': 1 })
    expect(report.counts.bySpineState).toEqual({ resolved: 2, ghost: 1, none: 1 })
    expect(report.counts.byMachineStage).toEqual({ nurture: 2, tour_scheduled: 1, none: 1 })
    // The couple with no state at all still reads off the machine
    // (nurture -> in conversation), which is why that is three and not two.
    expect(report.counts.byOperatorStage).toEqual({
      in_conversation: 3,
      gone_quiet: 1,
    })
  })

  it('reads a merged row as merged, whatever its state column says', async () => {
    const report = await loadLifecycleDisagreements(
      fakeClient(
        [
          couple({
            id: 'folded-away',
            lifecycle_state: 'resolved',
            merged_into_id: 'other-couple',
            source_wedding_id: 'w1',
          }),
        ],
        [wedding({ id: 'w1', lifecycle_stage: 'nurture' })],
      ),
      VENUE,
      NOW,
    )
    expect(report.rows[0].spineState).toBe('merged')
    expect(report.rows[0].operatorStage).toBe('joined_up')
  })

  it('treats a stage the code does not know as no stage rather than passing it through', async () => {
    const report = await loadLifecycleDisagreements(
      fakeClient(
        [couple({ id: 'odd', lifecycle_state: 'resolved', source_wedding_id: 'w1' })],
        [wedding({ id: 'w1', lifecycle_stage: 'a_stage_from_the_future' })],
      ),
      VENUE,
      NOW,
    )
    expect(report.rows[0].machineStage).toBeNull()
    expect(report.rows[0].operatorStage).toBe('in_conversation')
  })

  it('takes a booking off the wedding row even when the record has not caught up', async () => {
    const report = await loadLifecycleDisagreements(
      fakeClient(
        [couple({ id: 'signed', lifecycle_state: 'resolved', source_wedding_id: 'w1' })],
        [
          wedding({
            id: 'w1',
            lifecycle_stage: null,
            booked_at: '2026-08-01T00:00:00.000Z',
            wedding_date: '2027-05-01',
          }),
        ],
      ),
      VENUE,
      NOW,
    )
    expect(report.rows[0].operatorStage).toBe('booked')
  })

  it('sorts disagreements first, then one-sided, then the quiet agreement', async () => {
    const report = await loadLifecycleDisagreements(
      fakeClient(
        [
          couple({ id: 'agrees', lifecycle_state: 'resolved', source_wedding_id: 'w1' }),
          couple({ id: 'alone', lifecycle_state: 'resolved' }),
          couple({ id: 'disagrees', lifecycle_state: 'ghost', source_wedding_id: 'w2' }),
        ],
        [
          wedding({ id: 'w1', lifecycle_stage: 'nurture' }),
          wedding({ id: 'w2', lifecycle_stage: 'tour_scheduled' }),
        ],
      ),
      VENUE,
      NOW,
    )
    expect(report.rows.map((r) => r.coupleId)).toEqual(['disagrees', 'alone', 'agrees'])
  })
})
