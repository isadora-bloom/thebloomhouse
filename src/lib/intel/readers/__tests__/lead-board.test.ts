/**
 * The lead board reader, pinned. W62.
 *
 * Driven against the same in-memory Supabase fake the canonical reader
 * tests use, so nothing here touches a database. The fake is a real
 * filter engine rather than a canned response, which is the point: the
 * mistakes a reader like this makes are scope mistakes — forgetting the
 * venue filter, counting a merged-away tombstone as a live couple,
 * rendering a failed read as a confident zero.
 */

import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from '@/lib/intel/tool-sources/__tests__/fake-supabase-memory'
import { loadLeadBoard, MIRROR_COLUMNS } from '../lead-board'

const VENUE = 'venue-1'
const OTHER_VENUE = 'venue-2'
const NOW = Date.parse('2026-09-14T12:00:00.000Z')

function fixture() {
  return {
    couples: [
      {
        id: 'C1',
        venue_id: VENUE,
        primary_contact_name: 'Ashley',
        partner_contact_name: 'Ryan',
        lifecycle_state: 'resolved',
        channel_scope: null,
        wedding_date: '2027-06-05',
        heat_score: null,
        last_progression_at: '2026-09-10T00:00:00.000Z',
        decay_window_days: 120,
        source_wedding_id: 'W1',
        merged_into_id: null,
        first_seen_at: '2026-08-01T00:00:00.000Z',
        point_zero_at: '2026-08-02T00:00:00.000Z',
      },
      {
        id: 'C2',
        venue_id: VENUE,
        primary_contact_name: 'Doug',
        partner_contact_name: null,
        lifecycle_state: 'channel_scoped',
        channel_scope: 'knot',
        wedding_date: null,
        heat_score: null,
        last_progression_at: null,
        decay_window_days: 120,
        source_wedding_id: null,
        merged_into_id: null,
        first_seen_at: null,
        point_zero_at: null,
      },
      {
        // Merged away: a pointer at a couple, not a couple.
        id: 'C3',
        venue_id: VENUE,
        primary_contact_name: 'Ashley Duplicate',
        partner_contact_name: null,
        lifecycle_state: 'resolved',
        channel_scope: null,
        wedding_date: null,
        heat_score: null,
        last_progression_at: null,
        decay_window_days: 120,
        source_wedding_id: null,
        merged_into_id: 'C1',
        first_seen_at: null,
        point_zero_at: null,
      },
      {
        // Another venue entirely.
        id: 'C4',
        venue_id: OTHER_VENUE,
        primary_contact_name: 'Somebody Else',
        partner_contact_name: null,
        lifecycle_state: 'resolved',
        channel_scope: null,
        wedding_date: null,
        heat_score: null,
        last_progression_at: null,
        decay_window_days: 120,
        source_wedding_id: 'W9',
        merged_into_id: null,
        first_seen_at: null,
        point_zero_at: null,
      },
    ],
    touchpoints: [
      {
        couple_id: 'C1',
        venue_id: VENUE,
        channel: 'knot',
        action_type: 'inquiry',
        signal_tier: 'high',
        occurred_at: '2026-08-01T00:00:00.000Z',
      },
      {
        couple_id: 'C1',
        venue_id: VENUE,
        channel: 'gmail',
        action_type: 'reply',
        signal_tier: 'highest',
        occurred_at: '2026-09-13T00:00:00.000Z',
      },
      {
        couple_id: 'C2',
        venue_id: VENUE,
        channel: 'knot',
        action_type: 'inquiry',
        signal_tier: 'low',
        occurred_at: '2026-05-01T00:00:00.000Z',
      },
    ],
    couple_progression_events: [
      {
        couple_id: 'C1',
        event_type: 'tour_attended',
        occurred_at: '2026-09-05T00:00:00.000Z',
      },
      {
        couple_id: 'C1',
        event_type: 'tour_booked',
        occurred_at: '2026-08-20T00:00:00.000Z',
      },
    ],
    fragments: [
      { id: 'F1', venue_id: VENUE, promoted_to_couple_id: null },
      { id: 'F2', venue_id: VENUE, promoted_to_couple_id: null },
      { id: 'F3', venue_id: VENUE, promoted_to_couple_id: 'C1' },
      { id: 'F4', venue_id: OTHER_VENUE, promoted_to_couple_id: null },
    ],
    venues: [
      { id: VENUE, name: 'Rixey Manor' },
      { id: OTHER_VENUE, name: 'Somewhere Else' },
    ],
    weddings: [
      {
        id: 'W1',
        venue_id: VENUE,
        status: 'tour_completed',
        booked_at: null,
        lifecycle_stage: 'tour_completed',
        lifecycle_stage_set_at: '2026-09-05T00:00:00.000Z',
        code_extension: 'A',
        confidence_flag: 'imported_low',
        import_warnings: [{ field: 'couple_name', issue: 'could not split' }],
        guest_count_estimate: 120,
      },
      {
        id: 'W9',
        venue_id: OTHER_VENUE,
        status: 'booked',
        booked_at: '2026-01-01T00:00:00.000Z',
        lifecycle_stage: 'booked',
        lifecycle_stage_set_at: null,
        code_extension: null,
        confidence_flag: null,
        import_warnings: null,
        guest_count_estimate: null,
      },
    ],
    client_codes: [{ wedding_id: 'W1', code: 'RM-0042' }],
  }
}

describe('loadLeadBoard', () => {
  it('is honestly empty when there is no venue to read', async () => {
    const board = await loadLeadBoard(makeFakeSupabase({}), [], NOW)
    expect(board.rows).toEqual([])
    expect(board.heatAvailable).toBe(true)
    expect(board.warnings).toEqual([])
  })

  it('reads the spine, one row per live couple', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    expect(board.rows.map((r) => r.coupleId).sort()).toEqual(['C1', 'C2'])
  })

  it('leaves a merged-away couple out: it is a pointer, not a couple', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    expect(board.rows.map((r) => r.coupleId)).not.toContain('C3')
  })

  it('never reaches into another venue', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    expect(board.rows.map((r) => r.coupleId)).not.toContain('C4')
    expect(board.rows.every((r) => r.venueId === VENUE)).toBe(true)
  })

  it('takes the arrival channel from the earliest signal and last activity from the newest', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    const c1 = board.rows.find((r) => r.coupleId === 'C1')
    expect(c1?.firstChannel).toBe('knot')
    expect(c1?.lastSignal?.at).toBe('2026-09-13T00:00:00.000Z')
    expect(c1?.lastSignal?.channel).toBe('gmail')
    expect(c1?.touchpointCount).toBe(2)
  })

  it('falls back to the channel scope when a couple has no ribbon', async () => {
    const data = fixture()
    data.touchpoints = data.touchpoints.filter((t) => t.couple_id !== 'C2')
    const board = await loadLeadBoard(makeFakeSupabase(data), [VENUE], NOW)
    const c2 = board.rows.find((r) => r.coupleId === 'C2')
    expect(c2?.firstChannel).toBe('knot')
    expect(c2?.lastSignal).toBeNull()
  })

  it('scores heat from the ribbon, so a recent top-tier signal outranks an old weak one', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    const c1 = board.rows.find((r) => r.coupleId === 'C1')
    const c2 = board.rows.find((r) => r.coupleId === 'C2')
    expect(c1?.heat?.contributingCount).toBe(2)
    expect(c1?.heat?.score ?? 0).toBeGreaterThan(c2?.heat?.score ?? 0)
    expect(c1?.heat?.bucket).toBe('hot')
    // The working is carried too, not just the number.
    expect(c1?.heat?.evidence.length).toBeGreaterThan(0)
  })

  it('reduces the inbound anchors to the facts the stage needs', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    const c1 = board.rows.find((r) => r.coupleId === 'C1')
    expect(c1?.progression.count).toBe(2)
    expect(c1?.progression.tourAttendedAt).toBe('2026-09-05T00:00:00.000Z')
    expect(c1?.progression.tourBookedAt).toBe('2026-08-20T00:00:00.000Z')
    expect(c1?.progression.contractSignedAt).toBeNull()
    // Newest first, so the latest anchor is the attended tour.
    expect(c1?.progression.lastEventType).toBe('tour_attended')
  })

  it('joins the mirror for what the spine has no column for', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    const c1 = board.rows.find((r) => r.coupleId === 'C1')
    expect(c1?.machineStage).toBe('tour_completed')
    expect(c1?.machineStageSetAt).toBe('2026-09-05T00:00:00.000Z')
    expect(c1?.codeExtension).toBe('A')
    expect(c1?.confidenceFlag).toBe('imported_low')
    expect(c1?.importWarnings?.[0]?.field).toBe('couple_name')
    expect(c1?.guestCountEstimate).toBe(120)
    expect(c1?.clientCode).toBe('RM-0042')
  })

  it('still produces a row for a couple with no mirrored wedding', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    const c2 = board.rows.find((r) => r.coupleId === 'C2')
    expect(c2).toBeDefined()
    expect(c2?.weddingId).toBeNull()
    expect(c2?.machineStage).toBeNull()
    expect(c2?.clientCode).toBeNull()
    expect(c2?.names).toBe('Doug')
  })

  it('counts the signals that never attached to anybody, in this venue only', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    expect(board.unattachedFragments).toBe(2)
  })

  it('carries the venue name so a multi-venue board can label its cards', async () => {
    const board = await loadLeadBoard(makeFakeSupabase(fixture()), [VENUE], NOW)
    expect(board.rows[0].venueName).toBe('Rixey Manor')
  })
})

describe('loadLeadBoard — when a read fails', () => {
  /** Wraps the fake and makes one table error, the way a permissions
   *  problem or a timeout does in production. */
  function failingOn(table: string, data: Record<string, unknown[]>): SupabaseClient {
    const inner = makeFakeSupabase(data as never)
    return {
      from(name: string) {
        if (name !== table) return (inner as unknown as { from: (t: string) => unknown }).from(name)
        const chain: Record<string, unknown> = {}
        const passthrough = () => chain
        for (const key of [
          'select',
          'eq',
          'neq',
          'is',
          'in',
          'gte',
          'gt',
          'lte',
          'lt',
          'not',
          'order',
          'limit',
          'range',
        ]) {
          chain[key] = passthrough
        }
        const failure = {
          data: null,
          count: null,
          error: { message: `${table} is unreadable` },
        }
        chain.maybeSingle = () => Promise.resolve(failure)
        chain.single = () => Promise.resolve(failure)
        chain.then = (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
          Promise.resolve(failure).then(ok, bad)
        return chain
      },
    } as unknown as SupabaseClient
  }

  it('says heat is unknown rather than zero when the ribbon cannot be read', async () => {
    const board = await loadLeadBoard(failingOn('touchpoints', fixture()), [VENUE], NOW)
    expect(board.heatAvailable).toBe(false)
    expect(board.rows.length).toBe(2)
    expect(board.rows.every((r) => r.heat === null)).toBe(true)
    expect(board.warnings.join(' ')).toMatch(/unknown rather than cold/i)
  })

  it('keeps every row when the mirror cannot be read, and says what was lost', async () => {
    const board = await loadLeadBoard(failingOn('weddings', fixture()), [VENUE], NOW)
    expect(board.rows.length).toBe(2)
    expect(board.rows.every((r) => r.machineStage === null)).toBe(true)
    expect(board.warnings.join(' ')).toMatch(/pipeline stages could not be read/i)
  })

  it('returns nothing and says why when the couples read itself fails', async () => {
    const board = await loadLeadBoard(failingOn('couples', fixture()), [VENUE], NOW)
    expect(board.rows).toEqual([])
    expect(board.heatAvailable).toBe(false)
    expect(board.warnings[0]).toMatch(/Could not read couples/)
  })
})

describe('the mirror seam is written down', () => {
  it('names a reason for every column it joins', () => {
    for (const [column, reason] of Object.entries(MIRROR_COLUMNS)) {
      expect(reason.length, `${column} needs a reason`).toBeGreaterThan(20)
    }
  })

  it('stays small enough to be a seam rather than a second reader', () => {
    // If this trips, the mirror has grown into a weddings read wearing a
    // reader's coat. Shrink it, or make the case in the plan.
    expect(Object.keys(MIRROR_COLUMNS).length).toBeLessThanOrEqual(8)
  })
})
