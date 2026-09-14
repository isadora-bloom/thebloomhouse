/**
 * loadVenueImpact — the two windowed counts behind /intel/roi.
 *
 * The two things worth pinning down: direction is never inferred (a
 * touchpoint with no write-time stamp is reported as unstamped, not
 * counted as an inquiry), and a booking is a couple, not a touchpoint,
 * so two contract events on one couple in one month is one booking.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '../../tool-sources/__tests__/fake-supabase-memory'
import { loadVenueImpact } from '../venue-impact'

const VENUE = 'venue-1'
// Mid-month so "this month" and "last month" are unambiguous.
const NOW = new Date(2026, 8, 14, 12, 0, 0) // 14 Sep 2026, local

function tp(over: Record<string, unknown>) {
  return {
    couple_id: 'C1',
    channel: 'gmail',
    action_type: 'reply',
    direction: 'inbound',
    venue_id: VENUE,
    occurred_at: new Date(2026, 8, 5).toISOString(),
    ...over,
  }
}

describe('loadVenueImpact', () => {
  it('counts inbound touchpoints this month against last', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [
        tp({ occurred_at: new Date(2026, 8, 2).toISOString() }),
        tp({ occurred_at: new Date(2026, 8, 9).toISOString() }),
        tp({ occurred_at: new Date(2026, 7, 20).toISOString() }),
      ],
    })
    const impact = await loadVenueImpact(sb, VENUE, { now: NOW })
    expect(impact.inquiries).toEqual({ thisMonth: 2, lastMonth: 1 })
  })

  it('never counts an unstamped touchpoint as inbound, and reports how many it skipped', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [
        tp({ direction: null, occurred_at: new Date(2026, 8, 3).toISOString() }),
        tp({ direction: null, occurred_at: new Date(2026, 8, 4).toISOString() }),
        tp({ occurred_at: new Date(2026, 8, 5).toISOString() }),
      ],
    })
    const impact = await loadVenueImpact(sb, VENUE, { now: NOW })
    expect(impact.inquiries.thisMonth).toBe(1)
    expect(impact.unstampedThisMonth).toBe(2)
  })

  it('does not count outbound venue activity as an inquiry', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [
        tp({ direction: 'outbound', occurred_at: new Date(2026, 8, 3).toISOString() }),
        tp({ direction: 'outbound', occurred_at: new Date(2026, 8, 4).toISOString() }),
      ],
    })
    const impact = await loadVenueImpact(sb, VENUE, { now: NOW })
    expect(impact.inquiries.thisMonth).toBe(0)
    expect(impact.unstampedThisMonth).toBe(0)
  })

  it('counts a booking once per couple however many contract events it has', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [
        tp({ couple_id: 'C1', channel: 'honeybook', action_type: 'contract_signed', occurred_at: new Date(2026, 8, 3).toISOString() }),
        tp({ couple_id: 'C1', channel: 'honeybook', action_type: 'booking_signed', occurred_at: new Date(2026, 8, 4).toISOString() }),
        tp({ couple_id: 'C2', channel: 'honeybook', action_type: 'contract_signed', occurred_at: new Date(2026, 8, 6).toISOString() }),
        tp({ couple_id: 'C3', channel: 'honeybook', action_type: 'contract_signed', occurred_at: new Date(2026, 7, 6).toISOString() }),
      ],
    })
    const impact = await loadVenueImpact(sb, VENUE, { now: NOW })
    expect(impact.bookings).toEqual({ thisMonth: 2, lastMonth: 1 })
  })

  it('ignores another venue and anything older than last month', async () => {
    const sb = makeFakeSupabase({
      touchpoints: [
        tp({ venue_id: 'venue-2', occurred_at: new Date(2026, 8, 3).toISOString() }),
        tp({ occurred_at: new Date(2026, 3, 3).toISOString() }),
      ],
    })
    const impact = await loadVenueImpact(sb, VENUE, { now: NOW })
    expect(impact.inquiries).toEqual({ thisMonth: 0, lastMonth: 0 })
  })

  it('returns honest zeroes with no venue, without querying', async () => {
    const sb = makeFakeSupabase({ touchpoints: [tp({})] })
    const impact = await loadVenueImpact(sb, '', { now: NOW })
    expect(impact.inquiries).toEqual({ thisMonth: 0, lastMonth: 0 })
    expect(impact.bookings).toEqual({ thisMonth: 0, lastMonth: 0 })
  })
})
