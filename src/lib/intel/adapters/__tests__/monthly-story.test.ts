/**
 * The monthly story adapter (W52).
 *
 * Two things are worth pinning.
 *
 * 1. The mapping. Four readers, four panels, and every panel keeps its
 *    reader's honesty: an under-floor number is withheld rather than
 *    printed, a zero denominator never becomes a zero, and a failed read
 *    reads as a failure rather than as an empty venue.
 *
 * 2. That the panels are a summary and not a second opinion. The weekday
 *    table is the one `computeFunnel` already built, so the test feeds a
 *    `FunnelSegment[]` in exactly the shape that function emits (the
 *    weekday quirk included: `inquiries` is overwritten with `toured`
 *    there, and `tourToBooked` is the answer).
 *
 * `loadMonthlyStory` is exercised against a fake Supabase client, same
 * predicate-filtering shape as since-last-here.test.ts, to prove it is
 * the client it is given that gets used and that one reader failing does
 * not take the other three with it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Distribution, SourceAttribution } from '@/lib/intel/canonical'
import type { FunnelSegment } from '@/lib/services/cohort/types'
import type { ReviewsAnalyticsRollup } from '@/lib/services/intel/reviews-analytics'
import {
  MIN_TOURS_PER_WEEKDAY,
  buildMonthlyStoryView,
  loadMonthlyStory,
  type MonthlyStoryFacts,
  type MonthlyStoryPanelKey,
} from '../monthly-story'
import { WITHHELD } from '../honesty'

// ─────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────

function dist(value: number | null, n: number, enoughData: boolean, reason?: Distribution['reason']): Distribution {
  return { value, n, enoughData, reason }
}

function weekday(label: string, toured: number, booked: number): FunnelSegment {
  return {
    label,
    // The funnel overwrites `inquiries` with `toured` on this table.
    inquiries: toured,
    toured,
    booked,
    inquiryToTour: toured ? 1 : null,
    tourToBooked: toured === 0 ? null : booked / toured,
    inquiryToBooked: toured === 0 ? null : booked / toured,
  }
}

function attribution(channels: SourceAttribution['channels'], top: Partial<SourceAttribution> = {}): SourceAttribution {
  return {
    model: 'first_touch',
    channels,
    topByVolume: top.topByVolume ?? null,
    topByConversion: top.topByConversion ?? null,
    generatedAt: '2026-09-14T00:00:00.000Z',
  }
}

function reviews(partial: Partial<ReviewsAnalyticsRollup>): ReviewsAnalyticsRollup {
  return {
    venue_id: 'venue-1',
    total: 0,
    avg_rating: null,
    five_star_pct: 0,
    with_response_pct: 0,
    recent_30d_count: 0,
    recent_90d_count: 0,
    sources: [],
    monthly: [],
    top_themes: [],
    source_links: {} as ReviewsAnalyticsRollup['source_links'],
    sentiment_trend: { recent_avg: null, prior_avg: null, direction: 'unknown' },
    solicitations: {
      gap_count: 0,
      total_12mo: 0,
      received_12mo: 0,
      no_response_12mo: 0,
      queued: 0,
      sent: 0,
      received_rate_pct: null,
    },
    ...partial,
  }
}

function facts(partial: Partial<MonthlyStoryFacts> = {}): MonthlyStoryFacts {
  return {
    responseTime: { ok: true, value: dist(4, 40, true) },
    weekdayTours: {
      ok: true,
      value: [
        weekday('Sunday', 0, 0),
        weekday('Monday', 2, 1),
        weekday('Tuesday', 0, 0),
        weekday('Wednesday', 0, 0),
        weekday('Thursday', 0, 0),
        weekday('Friday', 10, 3),
        weekday('Saturday', 20, 12),
      ],
    },
    channels: {
      ok: true,
      value: attribution(
        [
          { channel: 'knot', n: 30, conversion: dist(0.2, 30, true), cac: dist(400, 6, true), revenuePerDollar: dist(3.5, 6, true) },
          { channel: 'website', n: 4, conversion: dist(0.25, 4, false, 'insufficient_sample'), cac: dist(null, 0, false, 'no_data'), revenuePerDollar: dist(null, 0, false, 'no_data') },
        ],
        { topByVolume: 'knot', topByConversion: 'knot' },
      ),
    },
    reviews: {
      ok: true,
      value: reviews({
        total: 24,
        avg_rating: 4.7,
        monthly: [
          { month: '2026-04', count: 3, avg_rating: 4.3, avg_sentiment: 0.4 },
          { month: '2026-05', count: 0, avg_rating: null, avg_sentiment: null },
          { month: '2026-06', count: 5, avg_rating: 4.8, avg_sentiment: 0.6 },
        ],
        sentiment_trend: { recent_avg: 0.6, prior_avg: 0.4, direction: 'rising' },
      }),
    },
    generatedAt: '2026-09-14T00:00:00.000Z',
    ...partial,
  }
}

function panel(view: ReturnType<typeof buildMonthlyStoryView>, key: MonthlyStoryPanelKey) {
  const p = view.panels.find((x) => x.key === key)
  if (!p) throw new Error(`no panel ${key}`)
  return p
}

// ─────────────────────────────────────────────────────────────────────
// The mapping
// ─────────────────────────────────────────────────────────────────────

describe('buildMonthlyStoryView — shape', () => {
  const view = buildMonthlyStoryView(facts())

  it('builds the four panels, in the order an owner asks about them', () => {
    expect(view.panels.map((p) => p.key)).toEqual([
      'response-time',
      'tour-weekday',
      'channel-roi',
      'reviews',
    ])
  })

  it('gives every panel a blurb, a source and a way through to the deeper page', () => {
    for (const p of view.panels) {
      expect(p.blurb.length).toBeGreaterThan(20)
      expect(p.provenance.length).toBeGreaterThan(20)
      expect(p.href.startsWith('/')).toBe(true)
      expect(p.hrefLabel.length).toBeGreaterThan(3)
    }
  })

  it('is not "all empty" when any panel has a finding', () => {
    expect(view.allEmpty).toBe(false)
  })
})

describe('response time panel', () => {
  it('states the median in words a person uses, with the sample beside it', () => {
    const p = panel(buildMonthlyStoryView(facts()), 'response-time')
    expect(p.isFinding).toBe(true)
    expect(p.headline).toContain('4 hours')
    expect(p.rows[0].note).toContain('40 couples')
  })

  it('says minutes when the venue is faster than an hour', () => {
    const p = panel(
      buildMonthlyStoryView(facts({ responseTime: { ok: true, value: dist(0.5, 40, true) } })),
      'response-time',
    )
    expect(p.headline).toContain('30 minutes')
  })

  it('says days when the venue is slower than two', () => {
    const p = panel(
      buildMonthlyStoryView(facts({ responseTime: { ok: true, value: dist(72, 40, true) } })),
      'response-time',
    )
    expect(p.headline).toContain('3 days')
  })

  it('withholds the number under the reporting floor and says why', () => {
    const p = panel(
      buildMonthlyStoryView(facts({ responseTime: { ok: true, value: dist(4, 3, false, 'insufficient_sample') } })),
      'response-time',
    )
    expect(p.isFinding).toBe(false)
    expect(p.rows).toEqual([])
    expect(p.headline).toContain('3 answered enquiries')
    expect(p.headline).not.toContain('4 hours')
  })

  it('says there is nothing rather than zero hours when there is no data at all', () => {
    const p = panel(
      buildMonthlyStoryView(facts({ responseTime: { ok: true, value: dist(null, 0, false, 'no_data') } })),
      'response-time',
    )
    expect(p.headline).toMatch(/no answered enquiries/i)
    expect(p.headline).not.toContain('0')
  })

  it('reads as an outage, not an empty venue, when the reader failed', () => {
    const p = panel(
      buildMonthlyStoryView(facts({ responseTime: { ok: false, error: 'boom' } })),
      'response-time',
    )
    expect(p.isFinding).toBe(false)
    expect(p.headline).toMatch(/would not load/i)
  })
})

describe('weekday tour panel', () => {
  const p = panel(buildMonthlyStoryView(facts()), 'tour-weekday')

  it('names the best day off tourToBooked, the number the funnel already built', () => {
    expect(p.headline).toContain('Saturday')
    expect(p.headline).toContain('60%')
  })

  it('lists only days that actually had tours', () => {
    expect(p.rows.map((r) => r.label)).toEqual(['Monday', 'Friday', 'Saturday'])
  })

  it(`withholds a rate for a day under ${MIN_TOURS_PER_WEEKDAY} tours rather than printing one`, () => {
    const monday = p.rows.find((r) => r.label === 'Monday')!
    expect(monday.value).toBe(WITHHELD)
    expect(monday.dim).toBe(true)
    expect(monday.note).toMatch(/too few/i)
  })

  it('marks exactly one standout', () => {
    expect(p.rows.filter((r) => r.standout).map((r) => r.label)).toEqual(['Saturday'])
  })

  it('says so plainly when no day has enough tours to rate', () => {
    const thin = panel(
      buildMonthlyStoryView(
        facts({ weekdayTours: { ok: true, value: [weekday('Saturday', 2, 2), weekday('Friday', 1, 0)] } }),
      ),
      'tour-weekday',
    )
    expect(thin.isFinding).toBe(false)
    expect(thin.headline).toMatch(/no single day has enough/i)
    expect(thin.rows.every((r) => r.value === WITHHELD)).toBe(true)
  })

  it('says there are no tours rather than drawing seven zeroes', () => {
    const none = panel(
      buildMonthlyStoryView(
        facts({ weekdayTours: { ok: true, value: [weekday('Saturday', 0, 0), weekday('Friday', 0, 0)] } }),
      ),
      'tour-weekday',
    )
    expect(none.rows).toEqual([])
    expect(none.headline).toMatch(/no tours on record/i)
  })
})

describe('channel panel', () => {
  const p = panel(buildMonthlyStoryView(facts()), 'channel-roi')

  it('renders the return through the shared channel view, so /intel/sources cannot disagree', () => {
    const knot = p.rows.find((r) => r.key === 'knot')!
    expect(knot.value).toBe('3.50x')
    expect(knot.note).toContain('$400')
  })

  it('withholds a return with no spend behind it instead of calling it zero', () => {
    const website = p.rows.find((r) => r.key === 'website')!
    expect(website.value).toBe(WITHHELD)
    expect(website.dim).toBe(true)
    expect(website.note).toContain('4 couples')
  })

  it('says nothing is credited rather than showing an empty table', () => {
    const none = panel(
      buildMonthlyStoryView(facts({ channels: { ok: true, value: attribution([]) } })),
      'channel-roi',
    )
    expect(none.rows).toEqual([])
    expect(none.isFinding).toBe(false)
    expect(none.headline).toMatch(/no channels credited/i)
  })
})

describe('reviews panel', () => {
  const p = panel(buildMonthlyStoryView(facts()), 'reviews')

  it('leads with the average and the direction', () => {
    expect(p.headline).toContain('4.7')
    expect(p.headline).toMatch(/warmer/i)
  })

  it('shows a month with no reviews as empty rather than as zero stars', () => {
    const may = p.rows.find((r) => r.key === '2026-05')!
    expect(may.value).toBe(WITHHELD)
    expect(may.note).toMatch(/no reviews that month/i)
  })

  it('says so when there are no reviews at all', () => {
    const none = panel(buildMonthlyStoryView(facts({ reviews: { ok: true, value: reviews({}) } })), 'reviews')
    expect(none.rows).toEqual([])
    expect(none.isFinding).toBe(false)
    expect(none.headline).toMatch(/no reviews on file/i)
  })

  it('refuses to call a direction the rollup could not call', () => {
    const flat = panel(
      buildMonthlyStoryView(
        facts({
          reviews: {
            ok: true,
            value: reviews({
              total: 4,
              avg_rating: 4.2,
              sentiment_trend: { recent_avg: null, prior_avg: null, direction: 'unknown' },
            }),
          },
        }),
      ),
      'reviews',
    )
    expect(flat.headline).toMatch(/not enough reviews/i)
  })
})

describe('buildMonthlyStoryView — everything absent', () => {
  it('is allEmpty when not one reader had anything, and no panel prints a zero', () => {
    const view = buildMonthlyStoryView(
      facts({
        responseTime: { ok: true, value: dist(null, 0, false, 'no_data') },
        weekdayTours: { ok: true, value: [] },
        channels: { ok: true, value: attribution([]) },
        reviews: { ok: true, value: reviews({}) },
      }),
    )
    expect(view.allEmpty).toBe(true)
    for (const p of view.panels) {
      expect(p.rows).toEqual([])
      expect(p.empty).toBeTruthy()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────
// loadMonthlyStory — against a fake client
// ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/services/cohort', () => ({
  buildCohortIntel: vi.fn(),
}))
vi.mock('@/lib/services/intel/reviews-analytics', () => ({
  computeReviewsAnalytics: vi.fn(),
}))
vi.mock('@/lib/intel/canonical', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intel/canonical')>()
  return { ...actual, getSourceAttribution: vi.fn() }
})

const fakeSupabase = {} as never

/** The cohort build the happy-path tests stand on. Shaped like the real
 *  `CohortIntel` only as far as `mapCohortIntelToFunnel` and this adapter
 *  actually reach into it. */
const COHORT_INTEL = {
  funnel: { overall: [], byTourWeekday: [weekday('Saturday', 12, 6)] },
  responseTime: { overall: { n: 22, enoughData: true, median: 6 } },
  leadTime: { dist: { n: 22, enoughData: true, median: 200 } },
  curve: { bands: [], kneeBandIndex: null },
  textPatterns: { families: [] },
  generatedAt: '2026-09-14T00:00:00.000Z',
}

describe('loadMonthlyStory', () => {
  // The vitest config clears mock implementations between tests, so the
  // defaults are re-armed here rather than once at module scope.
  beforeEach(async () => {
    const { buildCohortIntel } = await import('@/lib/services/cohort')
    const { computeReviewsAnalytics } = await import('@/lib/services/intel/reviews-analytics')
    const { getSourceAttribution } = await import('@/lib/intel/canonical')
    vi.mocked(buildCohortIntel).mockResolvedValue(COHORT_INTEL as never)
    vi.mocked(getSourceAttribution).mockResolvedValue(attribution([]))
    vi.mocked(computeReviewsAnalytics).mockResolvedValue(reviews({}))
  })

  it('returns honest-empty slices with no venue in scope, and reads nothing', async () => {
    const result = await loadMonthlyStory(fakeSupabase, '')
    expect(result.responseTime.ok).toBe(false)
    expect(result.weekdayTours.ok).toBe(false)
    expect(result.channels.ok).toBe(false)
    expect(result.reviews.ok).toBe(false)
  })

  it('takes response time and the weekday table off one cohort build', async () => {
    const { buildCohortIntel } = await import('@/lib/services/cohort')

    const result = await loadMonthlyStory(fakeSupabase, 'venue-1')

    expect(vi.mocked(buildCohortIntel)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(buildCohortIntel).mock.calls[0][0]).toBe(fakeSupabase)
    expect(result.responseTime).toEqual({ ok: true, value: { value: 6, n: 22, enoughData: true } })
    expect(result.weekdayTours).toEqual({ ok: true, value: COHORT_INTEL.funnel.byTourWeekday })
  })

  it('passes the injected client to the reviews rollup rather than making its own', async () => {
    const { computeReviewsAnalytics } = await import('@/lib/services/intel/reviews-analytics')
    await loadMonthlyStory(fakeSupabase, 'venue-1')
    expect(vi.mocked(computeReviewsAnalytics).mock.calls.at(-1)?.[1]).toBe(fakeSupabase)
  })

  it('keeps the other three slices when one reader throws', async () => {
    const { computeReviewsAnalytics } = await import('@/lib/services/intel/reviews-analytics')
    vi.mocked(computeReviewsAnalytics).mockRejectedValueOnce(new Error('reviews are down'))

    const result = await loadMonthlyStory(fakeSupabase, 'venue-1')
    expect(result.reviews).toEqual({ ok: false, error: 'reviews are down' })
    expect(result.responseTime.ok).toBe(true)
    expect(result.channels.ok).toBe(true)
  })

  it('fails both cohort slices together when the cohort build throws, and nothing else', async () => {
    const { buildCohortIntel } = await import('@/lib/services/cohort')
    vi.mocked(buildCohortIntel).mockRejectedValueOnce(new Error('cohort is down'))

    const result = await loadMonthlyStory(fakeSupabase, 'venue-1')
    expect(result.responseTime).toEqual({ ok: false, error: 'cohort is down' })
    expect(result.weekdayTours).toEqual({ ok: false, error: 'cohort is down' })
    expect(result.channels.ok).toBe(true)
  })
})
