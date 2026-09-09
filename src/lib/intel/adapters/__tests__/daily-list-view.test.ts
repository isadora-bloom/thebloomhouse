/**
 * Triage rail — the four counts, and the rule behind each one.
 *
 * The regression these guard against is subtle: a bucket that renders a
 * count with no rule and no source is exactly the unsourced number the
 * two agent pages used to show. So the tests assert the copy is there,
 * not only the arithmetic.
 */

import { describe, it, expect } from 'vitest'
import type { DailyList, VenueOverview } from '@/lib/intel/canonical'
import { buildTriageRail, urgentOverlap } from '../daily-list-view'

const overview: VenueOverview = {
  couples: {
    total: 120,
    byLifecycle: {
      channel_scoped: 30,
      resolved: 60,
      booked: 20,
      completed: 8,
      ghost: 2,
      agent: 0,
    },
  },
  recentActivity: [],
  dataMaturity: {
    backfillStatus: 'populated',
    oldestTouchpoint: '2024-03-01T00:00:00Z',
    n: 4210,
  },
  generatedAt: '2026-09-08T00:00:00.000Z',
}

const daily: DailyList = {
  needsReply: [
    { id: 'c1', names: 'A & B' },
    { id: 'c2', names: 'C & D' },
  ],
  goingCold: [
    { id: 'c2', names: 'C & D' },
    { id: 'c9', names: null },
  ],
  toursThisWeek: [{ id: 't1', coupleId: 'c1', scheduledAt: '2026-09-10T15:00:00Z' }],
  highIntent: [{ id: 'c1', names: 'A & B' }],
  generatedAt: '2026-09-08T00:00:00.000Z',
}

describe('buildTriageRail', () => {
  it('returns the four buckets in operator order', () => {
    const rail = buildTriageRail(daily, overview)
    expect(rail.buckets.map((b) => b.key)).toEqual([
      'needsReply',
      'goingCold',
      'toursThisWeek',
      'highIntent',
    ])
  })

  it('counts each bucket from the reader, not from a local rule', () => {
    const rail = buildTriageRail(daily, overview)
    expect(rail.buckets.map((b) => b.count)).toEqual([2, 2, 1, 1])
  })

  it('gives every bucket a rule and a source, so no count is unexplained', () => {
    for (const b of buildTriageRail(daily, overview).buckets) {
      expect(b.rule.length).toBeGreaterThan(20)
      expect(b.source).toContain('getDailyList')
      expect(b.emptyCopy.length).toBeGreaterThan(10)
    }
  })

  it('names the thresholds it uses so they can be checked against the code', () => {
    const rail = buildTriageRail(daily, overview)
    const byKey = Object.fromEntries(rail.buckets.map((b) => [b.key, b]))
    expect(byKey.needsReply.source).toContain('348')
    expect(byKey.goingCold.source).toContain('decay')
    expect(byKey.goingCold.rule).toContain('three quarters')
    expect(byKey.highIntent.rule).toContain('60')
  })

  it('carries the sample size and history depth alongside the counts', () => {
    const rail = buildTriageRail(daily, overview)
    expect(rail.totalCouples).toBe(120)
    expect(rail.touchpointCount).toBe(4210)
    expect(rail.oldestTouchpoint).toBe('2024-03-01T00:00:00Z')
    expect(rail.spineEmpty).toBe(false)
    expect(rail.byLifecycle.booked).toBe(20)
  })

  it('flags an empty spine so the rail can refuse to show four zeros', () => {
    const bare: VenueOverview = {
      ...overview,
      couples: { total: 0, byLifecycle: { ...overview.couples.byLifecycle } },
      dataMaturity: { backfillStatus: 'empty', oldestTouchpoint: null, n: 0 },
    }
    expect(buildTriageRail(daily, bare).spineEmpty).toBe(true)
  })

  it('previews a handful of couples but never the whole bucket', () => {
    const many: DailyList = {
      ...daily,
      needsReply: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, names: `N${i}` })),
    }
    const bucket = buildTriageRail(many, overview).buckets[0]
    expect(bucket.count).toBe(12)
    expect(bucket.preview).toHaveLength(5)
  })

  it('leaves the tours preview empty — a TourRef is not a CoupleRef', () => {
    const bucket = buildTriageRail(daily, overview).buckets[2]
    expect(bucket.preview).toEqual([])
    expect(bucket.count).toBe(1)
  })
})

describe('urgentOverlap', () => {
  it('finds couples that are both waiting on a reply and going cold', () => {
    expect(urgentOverlap(daily).map((c) => c.id)).toEqual(['c2'])
  })

  it('is empty when the buckets do not intersect', () => {
    expect(
      urgentOverlap({ ...daily, goingCold: [{ id: 'zz', names: null }] }),
    ).toEqual([])
  })
})
