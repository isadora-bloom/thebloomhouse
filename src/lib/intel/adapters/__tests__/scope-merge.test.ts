/**
 * Scope merge — additive only.
 *
 * The one thing worth locking here is the boundary: counts merge, lists
 * merge, and there is no ratio merge to be found. The last test asserts
 * the module exports nothing that would let a caller add two conversion
 * rates together, because that is the mistake this whole workstream is
 * about.
 */

import { describe, it, expect } from 'vitest'
import type { DailyList, VenueOverview } from '@/lib/intel/canonical'
import * as scopeMerge from '../scope-merge'
import {
  emptyDailyList,
  emptyVenueOverview,
  mergeDailyLists,
  mergeVenueOverviews,
} from '../scope-merge'

function overview(over: Partial<VenueOverview> = {}): VenueOverview {
  return {
    couples: {
      total: 0,
      byLifecycle: {
        channel_scoped: 0,
        resolved: 0,
        booked: 0,
        completed: 0,
        ghost: 0,
        agent: 0,
      },
    },
    recentActivity: [],
    dataMaturity: { backfillStatus: 'empty', oldestTouchpoint: null, n: 0 },
    generatedAt: '2026-09-08T00:00:00.000Z',
    ...over,
  }
}

describe('mergeVenueOverviews', () => {
  it('returns honest-empty for no venues', () => {
    const m = mergeVenueOverviews([])
    expect(m.couples.total).toBe(0)
    expect(m.dataMaturity.backfillStatus).toBe('unknown')
    expect(m.dataMaturity.oldestTouchpoint).toBeNull()
  })

  it('returns the single part untouched rather than rebuilding it', () => {
    const one = overview({ couples: { total: 7, byLifecycle: { ...overview().couples.byLifecycle, booked: 7 } } })
    expect(mergeVenueOverviews([one])).toBe(one)
  })

  it('sums totals and per-lifecycle counts exactly', () => {
    const a = overview({
      couples: {
        total: 10,
        byLifecycle: { ...overview().couples.byLifecycle, resolved: 6, booked: 4 },
      },
    })
    const b = overview({
      couples: {
        total: 5,
        byLifecycle: { ...overview().couples.byLifecycle, resolved: 1, ghost: 4 },
      },
    })
    const m = mergeVenueOverviews([a, b])
    expect(m.couples.total).toBe(15)
    expect(m.couples.byLifecycle.resolved).toBe(7)
    expect(m.couples.byLifecycle.booked).toBe(4)
    expect(m.couples.byLifecycle.ghost).toBe(4)
  })

  it('takes the earliest touchpoint across venues, not the first venue seen', () => {
    const a = overview({
      dataMaturity: { backfillStatus: 'populated', oldestTouchpoint: '2025-06-01T00:00:00Z', n: 100 },
    })
    const b = overview({
      dataMaturity: { backfillStatus: 'populated', oldestTouchpoint: '2023-01-15T00:00:00Z', n: 40 },
    })
    const m = mergeVenueOverviews([a, b])
    expect(m.dataMaturity.oldestTouchpoint).toBe('2023-01-15T00:00:00Z')
    expect(m.dataMaturity.n).toBe(140)
    expect(m.dataMaturity.backfillStatus).toBe('populated')
  })

  it('reports empty only when every venue is empty', () => {
    const empty = overview()
    const populated = overview({
      dataMaturity: { backfillStatus: 'populated', oldestTouchpoint: '2025-01-01T00:00:00Z', n: 3 },
    })
    expect(mergeVenueOverviews([empty, empty]).dataMaturity.backfillStatus).toBe('empty')
    expect(mergeVenueOverviews([empty, populated]).dataMaturity.backfillStatus).toBe(
      'populated',
    )
  })

  it('interleaves recent activity newest-first and caps it at one venue-worth', () => {
    const item = (id: string, at: string) => ({ id, kind: 'gmail/reply', occurredAt: at, summary: id })
    const a = overview({
      recentActivity: Array.from({ length: 8 }, (_, i) =>
        item(`a${i}`, `2026-09-0${8 - Math.min(i, 7)}T10:00:00Z`),
      ),
    })
    const b = overview({
      recentActivity: [item('b-newest', '2026-09-09T09:00:00Z')],
    })
    const m = mergeVenueOverviews([a, b])
    expect(m.recentActivity[0].id).toBe('b-newest')
    expect(m.recentActivity.length).toBeLessThanOrEqual(12)
  })
})

function daily(over: Partial<DailyList> = {}): DailyList {
  return { ...emptyDailyList('2026-09-08T00:00:00.000Z'), ...over }
}

describe('mergeDailyLists', () => {
  it('returns honest-empty for no venues', () => {
    const m = mergeDailyLists([])
    expect(m.needsReply).toEqual([])
    expect(m.goingCold).toEqual([])
    expect(m.toursThisWeek).toEqual([])
    expect(m.highIntent).toEqual([])
  })

  it('concatenates every bucket', () => {
    const a = daily({
      needsReply: [{ id: 'c1', names: 'A & B' }],
      highIntent: [{ id: 'c1', names: 'A & B' }],
    })
    const b = daily({
      needsReply: [{ id: 'c2', names: 'C & D' }],
      goingCold: [{ id: 'c3', names: 'E & F' }],
    })
    const m = mergeDailyLists([a, b])
    expect(m.needsReply.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(m.goingCold.map((c) => c.id)).toEqual(['c3'])
    expect(m.highIntent.map((c) => c.id)).toEqual(['c1'])
  })

  it('orders tours across venues by when they actually are', () => {
    const a = daily({
      toursThisWeek: [{ id: 't1', coupleId: 'c1', scheduledAt: '2026-09-12T15:00:00Z' }],
    })
    const b = daily({
      toursThisWeek: [{ id: 't2', coupleId: 'c2', scheduledAt: '2026-09-10T11:00:00Z' }],
    })
    expect(mergeDailyLists([a, b]).toursThisWeek.map((t) => t.id)).toEqual(['t2', 't1'])
  })

  it('does not mutate the parts it merges', () => {
    const a = daily({ needsReply: [{ id: 'c1', names: 'A' }] })
    const b = daily({ needsReply: [{ id: 'c2', names: 'B' }] })
    mergeDailyLists([a, b])
    expect(a.needsReply).toHaveLength(1)
    expect(b.needsReply).toHaveLength(1)
  })
})

describe('the ratio boundary', () => {
  it('exports no attribution merge — rates are not additive', () => {
    const names = Object.keys(scopeMerge)
    expect(names.some((n) => /attribution/i.test(n))).toBe(false)
    expect(names.sort()).toEqual([
      'emptyDailyList',
      'emptyVenueOverview',
      'mergeDailyLists',
      'mergeVenueOverviews',
    ])
  })

  it('emptyVenueOverview reports unknown, not empty — nothing was looked at', () => {
    expect(emptyVenueOverview().dataMaturity.backfillStatus).toBe('unknown')
  })
})
