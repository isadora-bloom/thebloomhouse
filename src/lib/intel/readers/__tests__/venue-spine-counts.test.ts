/**
 * W63 — per-venue spine counts.
 *
 * Driven by the in-memory fake Supabase, which is a real filter engine
 * rather than a canned stub, so the things these readers can get wrong
 * (losing the venue scope, counting a merged-away couple, folding an
 * unstamped direction into inbound) actually fail the test.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '@/lib/intel/tool-sources/__tests__/fake-supabase-memory'
import {
  loadInboundWindowCounts,
  loadUpcomingWeddings,
  loadVenueCoupleCounts,
} from '../venue-spine-counts'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'

function couple(over: Record<string, unknown>) {
  return {
    id: 'c1',
    venue_id: VENUE_A,
    lifecycle_state: 'resolved',
    merged_into_id: null,
    wedding_date: null,
    ...over,
  }
}

function touchpoint(over: Record<string, unknown>) {
  return {
    id: 't1',
    venue_id: VENUE_A,
    channel: 'gmail',
    direction: 'inbound',
    occurred_at: '2026-09-14T09:00:00.000Z',
    ...over,
  }
}

describe('loadVenueCoupleCounts', () => {
  it('splits couples by venue and lifecycle', async () => {
    const db = makeFakeSupabase({
      couples: [
        couple({ id: 'c1', lifecycle_state: 'resolved' }),
        couple({ id: 'c2', lifecycle_state: 'booked' }),
        couple({ id: 'c3', venue_id: VENUE_B, lifecycle_state: 'ghost' }),
      ],
    })
    const res = await loadVenueCoupleCounts(db, [VENUE_A, VENUE_B])
    const a = res.byVenue.find((v) => v.venueId === VENUE_A)!
    const b = res.byVenue.find((v) => v.venueId === VENUE_B)!
    expect(a.total).toBe(2)
    expect(a.byLifecycle.resolved).toBe(1)
    expect(a.byLifecycle.booked).toBe(1)
    expect(b.total).toBe(1)
    expect(b.byLifecycle.ghost).toBe(1)
  })

  it('leaves merged-away couples out — a tombstone is not a couple', async () => {
    const db = makeFakeSupabase({
      couples: [
        couple({ id: 'c1' }),
        couple({ id: 'c2', merged_into_id: 'c1' }),
      ],
    })
    const res = await loadVenueCoupleCounts(db, [VENUE_A])
    expect(res.byVenue[0].total).toBe(1)
  })

  it('returns a row of zeroes for a venue with nothing, not a missing row', async () => {
    const db = makeFakeSupabase({ couples: [] })
    const res = await loadVenueCoupleCounts(db, [VENUE_A])
    expect(res.byVenue).toHaveLength(1)
    expect(res.byVenue[0].total).toBe(0)
  })

  it('is honest-empty with no venues in scope', async () => {
    const db = makeFakeSupabase({ couples: [couple({})] })
    const res = await loadVenueCoupleCounts(db, [])
    expect(res.byVenue).toEqual([])
  })
})

describe('loadUpcomingWeddings', () => {
  it('counts couples whose wedding date falls inside the window', async () => {
    const db = makeFakeSupabase({
      couples: [
        couple({ id: 'c1', wedding_date: '2026-09-20' }),
        couple({ id: 'c2', wedding_date: '2026-12-01' }),
        couple({ id: 'c3', wedding_date: null }),
      ],
    })
    const res = await loadUpcomingWeddings(db, [VENUE_A], '2026-09-14', '2026-10-14')
    expect(res.count).toBe(1)
    expect(res.fromDate).toBe('2026-09-14')
  })

  it('keeps the venue scope', async () => {
    const db = makeFakeSupabase({
      couples: [couple({ id: 'c1', venue_id: VENUE_B, wedding_date: '2026-09-20' })],
    })
    const res = await loadUpcomingWeddings(db, [VENUE_A], '2026-09-14', '2026-10-14')
    expect(res.count).toBe(0)
  })
})

describe('loadInboundWindowCounts', () => {
  const FROM = '2026-09-13T12:00:00.000Z'
  const TO = '2026-09-14T12:00:00.000Z'
  const PRIOR_FROM = '2026-09-12T12:00:00.000Z'

  it('splits the current window from the one before it', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        touchpoint({ id: 't1', occurred_at: '2026-09-14T09:00:00.000Z' }),
        touchpoint({ id: 't2', occurred_at: '2026-09-13T20:00:00.000Z' }),
        touchpoint({ id: 't3', occurred_at: '2026-09-13T01:00:00.000Z' }),
      ],
    })
    const res = await loadInboundWindowCounts(db, {
      fromIso: FROM,
      toIso: TO,
      priorFromIso: PRIOR_FROM,
    })
    expect(res.current).toBe(2)
    expect(res.prior).toBe(1)
  })

  it('counts an unstamped direction as unknown rather than guessing it', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        touchpoint({ id: 't1', direction: null }),
        touchpoint({ id: 't2', direction: 'inbound' }),
        touchpoint({ id: 't3', direction: 'outbound' }),
      ],
    })
    const res = await loadInboundWindowCounts(db, { fromIso: FROM, toIso: TO })
    expect(res.current).toBe(1)
    expect(res.unknownDirection).toBe(1)
    expect(res.prior).toBeNull()
  })

  it('leaves non-message channels out of the ingestion count', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        touchpoint({ id: 't1', channel: 'calendly' }),
        touchpoint({ id: 't2', channel: 'gmail' }),
      ],
    })
    const res = await loadInboundWindowCounts(db, { fromIso: FROM, toIso: TO })
    expect(res.current).toBe(1)
  })

  it('splits the current window per venue', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        touchpoint({ id: 't1' }),
        touchpoint({ id: 't2', venue_id: VENUE_B }),
        touchpoint({ id: 't3', venue_id: VENUE_B }),
      ],
    })
    const res = await loadInboundWindowCounts(db, { fromIso: FROM, toIso: TO })
    expect(res.currentByVenue[VENUE_A]).toBe(1)
    expect(res.currentByVenue[VENUE_B]).toBe(2)
  })

  it('honours an explicit venue filter', async () => {
    const db = makeFakeSupabase({
      touchpoints: [touchpoint({ id: 't1' }), touchpoint({ id: 't2', venue_id: VENUE_B })],
    })
    const res = await loadInboundWindowCounts(db, {
      fromIso: FROM,
      toIso: TO,
      venueIds: [VENUE_A],
    })
    expect(res.current).toBe(1)
  })
})
