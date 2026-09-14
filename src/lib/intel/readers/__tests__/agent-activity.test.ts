/**
 * W63 — the three agent-analytics spine readers.
 */

import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '@/lib/intel/tool-sources/__tests__/fake-supabase-memory'
import {
  loadDecisionTimeline,
  loadFollowThrough,
  loadMessageVolume,
} from '../agent-activity'

const VENUE = 'venue-a'
const OTHER = 'venue-b'

function tp(over: Record<string, unknown>) {
  return {
    id: 't1',
    venue_id: VENUE,
    couple_id: 'c1',
    channel: 'gmail',
    direction: 'inbound',
    occurred_at: '2026-09-10T09:00:00.000Z',
    ...over,
  }
}

function couple(over: Record<string, unknown>) {
  return {
    id: 'c1',
    venue_id: VENUE,
    lifecycle_state: 'resolved',
    merged_into_id: null,
    first_seen_at: '2026-09-01T09:00:00.000Z',
    ...over,
  }
}

describe('loadMessageVolume', () => {
  it('groups by day and splits by the stamped direction', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        tp({ id: 't1', occurred_at: '2026-09-10T09:00:00.000Z', direction: 'inbound' }),
        tp({ id: 't2', occurred_at: '2026-09-10T11:00:00.000Z', direction: 'outbound' }),
        tp({ id: 't3', occurred_at: '2026-09-11T11:00:00.000Z', direction: 'inbound' }),
      ],
    })
    const res = await loadMessageVolume(db, [VENUE], '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    expect(res.days).toHaveLength(2)
    expect(res.days[0]).toEqual({ date: '2026-09-10', inbound: 1, outbound: 1, unknown: 0 })
    expect(res.totalInbound).toBe(2)
    expect(res.totalOutbound).toBe(1)
  })

  it('reports an unstamped direction instead of folding it into a side', async () => {
    const db = makeFakeSupabase({
      touchpoints: [tp({ id: 't1', direction: null }), tp({ id: 't2', direction: 'inbound' })],
    })
    const res = await loadMessageVolume(db, [VENUE], '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    expect(res.totalUnknown).toBe(1)
    expect(res.totalInbound).toBe(1)
    expect(res.totalOutbound).toBe(0)
  })

  it('windows on the event time, not on everything in the table', async () => {
    const db = makeFakeSupabase({
      touchpoints: [
        tp({ id: 't1', occurred_at: '2026-08-01T09:00:00.000Z' }),
        tp({ id: 't2', occurred_at: '2026-09-10T09:00:00.000Z' }),
      ],
    })
    const res = await loadMessageVolume(db, [VENUE], '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    expect(res.totalInbound).toBe(1)
  })

  it('keeps the venue scope', async () => {
    const db = makeFakeSupabase({ touchpoints: [tp({ id: 't1', venue_id: OTHER })] })
    const res = await loadMessageVolume(db, [VENUE], '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')
    expect(res.totalInbound).toBe(0)
  })
})

describe('loadFollowThrough', () => {
  it('counts couples who wrote in more than once against those who wrote at all', async () => {
    const db = makeFakeSupabase({
      couples: [couple({ id: 'c1' }), couple({ id: 'c2' })],
      touchpoints: [
        tp({ id: 't1', couple_id: 'c1' }),
        tp({ id: 't2', couple_id: 'c1' }),
        tp({ id: 't3', couple_id: 'c2' }),
      ],
    })
    const res = await loadFollowThrough(db, [VENUE], '2026-08-01T00:00:00.000Z')
    expect(res.sample).toBe(2)
    expect(res.returned).toBe(1)
    expect(res.rate).toBe(50)
  })

  it('returns null rather than a fake zero when nobody wrote in', async () => {
    const db = makeFakeSupabase({ couples: [couple({ id: 'c1' })], touchpoints: [] })
    const res = await loadFollowThrough(db, [VENUE], '2026-08-01T00:00:00.000Z')
    expect(res.rate).toBeNull()
    expect(res.sample).toBe(0)
  })

  it('ignores couples first seen before the window', async () => {
    const db = makeFakeSupabase({
      couples: [couple({ id: 'c1', first_seen_at: '2026-01-01T00:00:00.000Z' })],
      touchpoints: [tp({ id: 't1', couple_id: 'c1' })],
    })
    const res = await loadFollowThrough(db, [VENUE], '2026-08-01T00:00:00.000Z')
    expect(res.sample).toBe(0)
  })

  it('ignores outbound — a venue writing twice is not a couple coming back', async () => {
    const db = makeFakeSupabase({
      couples: [couple({ id: 'c1' })],
      touchpoints: [
        tp({ id: 't1', couple_id: 'c1', direction: 'inbound' }),
        tp({ id: 't2', couple_id: 'c1', direction: 'outbound' }),
      ],
    })
    const res = await loadFollowThrough(db, [VENUE], '2026-08-01T00:00:00.000Z')
    expect(res.returned).toBe(0)
  })
})

describe('loadDecisionTimeline', () => {
  it('measures first sight to contract, and bands the spans', async () => {
    const db = makeFakeSupabase({
      couples: [
        couple({ id: 'c1', lifecycle_state: 'booked', first_seen_at: '2026-09-01T00:00:00.000Z' }),
        couple({ id: 'c2', lifecycle_state: 'booked', first_seen_at: '2026-08-01T00:00:00.000Z' }),
      ],
      couple_progression_events: [
        { couple_id: 'c1', occurred_at: '2026-09-04T00:00:00.000Z', event_type: 'contract_signed' },
        { couple_id: 'c2', occurred_at: '2026-09-20T00:00:00.000Z', event_type: 'contract_signed' },
      ],
    })
    const res = await loadDecisionTimeline(db, [VENUE], '2026-06-01T00:00:00.000Z')
    expect(res.sample).toBe(2)
    // 3 days and 50 days.
    expect(res.averageDays).toBe(27)
    expect(res.fastPct).toBe(50)
    expect(res.slowPct).toBe(50)
    expect(res.typicalPct).toBe(0)
  })

  it('takes the earliest contract when a couple has more than one', async () => {
    const db = makeFakeSupabase({
      couples: [couple({ id: 'c1', lifecycle_state: 'booked', first_seen_at: '2026-09-01T00:00:00.000Z' })],
      couple_progression_events: [
        { couple_id: 'c1', occurred_at: '2026-09-11T00:00:00.000Z', event_type: 'contract_signed' },
        { couple_id: 'c1', occurred_at: '2026-09-03T00:00:00.000Z', event_type: 'contract_signed' },
      ],
    })
    const res = await loadDecisionTimeline(db, [VENUE], '2026-06-01T00:00:00.000Z')
    expect(res.averageDays).toBe(2)
  })

  it('reports a contract with no first sight as unmeasurable, not as zero days', async () => {
    const db = makeFakeSupabase({
      couples: [couple({ id: 'c1', lifecycle_state: 'booked', first_seen_at: null })],
      couple_progression_events: [
        { couple_id: 'c1', occurred_at: '2026-09-04T00:00:00.000Z', event_type: 'contract_signed' },
      ],
    })
    const res = await loadDecisionTimeline(db, [VENUE], '2026-06-01T00:00:00.000Z')
    expect(res.sample).toBe(0)
    expect(res.unmeasurable).toBe(1)
    expect(res.averageDays).toBeNull()
  })

  it('ignores progression rows that are not a contract', async () => {
    const db = makeFakeSupabase({
      couples: [couple({ id: 'c1', lifecycle_state: 'booked' })],
      couple_progression_events: [
        { couple_id: 'c1', occurred_at: '2026-09-04T00:00:00.000Z', event_type: 'tour_booked' },
      ],
    })
    const res = await loadDecisionTimeline(db, [VENUE], '2026-06-01T00:00:00.000Z')
    expect(res.sample).toBe(0)
  })
})
