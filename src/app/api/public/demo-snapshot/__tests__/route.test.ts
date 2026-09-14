/**
 * W58 — tests for the public, no-auth demo-snapshot route.
 *
 * Four things pinned here, matching NOVEMBER-PLAN.md Wave 8 "DONE WHEN":
 *   1. The venue guard: `loadDemoSnapshot` refuses when the venue id it is
 *      given is not flagged `is_demo = true` in the database, even though
 *      production code only ever calls it with the fixed config constant.
 *   2. The origin allow-list: an Origin the operator hasn't listed in
 *      `PUBLIC_DEMO_ALLOWED_ORIGINS` is refused before any DB read.
 *   3. The rate limiter is wired to the existing durable limiter with the
 *      documented generous bucket (60/min/IP), and a limited caller gets a
 *      429 with Retry-After.
 *   4. The response shape (counts + top-three rows + monthly-story panels +
 *      heat bands + up to three insight narrations), built entirely from
 *      composed reader/adapter output — and that nothing in that shape
 *      ever carries a real-venue marker (the repo's white-label pattern:
 *      `scripts/check-no-hardcoded-sage.mjs` for UI strings,
 *      `scripts/demo-reseed/roster.ts` FORBIDDEN_EMAIL_FRAGMENTS for demo
 *      data generation — this test applies the same idea to this route's
 *      JSON output).
 *
 * No network, no real database. Every reader/adapter this route composes
 * is mocked at the module boundary — this file pins the ROUTE's contract
 * (guard, CORS, rate limit, shape), not the readers' own logic, which is
 * already covered by their own unit tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import type { DailyList } from '@/lib/intel/canonical'
import type { MonthlyStoryView } from '@/lib/intel/adapters/monthly-story'
import type { HeatReport } from '@/lib/services/cohort/heat'
import type { NarratedCorrelation } from '@/lib/services/insights/correlation-narration'

// ---------------------------------------------------------------------------
// Mocks — one per composed module, matching the instagram-webhook route
// test's pattern (mock the service boundary, not a deep fake supabase).
// ---------------------------------------------------------------------------

const loadDailyListMock = vi.fn()
const loadMonthlyStoryMock = vi.fn()
const buildMonthlyStoryViewMock = vi.fn()
const loadCohortDataMock = vi.fn()
const buildHeatReportMock = vi.fn()
const listExistingNarrationsMock = vi.fn()
const checkRateLimitMock = vi.fn()
const clientIpMock = vi.fn()

vi.mock('@/lib/intel/canonical', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intel/canonical')>()
  return { ...actual, loadDailyList: (...a: unknown[]) => loadDailyListMock(...a) }
})

vi.mock('@/lib/intel/adapters/monthly-story', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/intel/adapters/monthly-story')>()
  return {
    ...actual,
    loadMonthlyStory: (...a: unknown[]) => loadMonthlyStoryMock(...a),
    buildMonthlyStoryView: (...a: unknown[]) => buildMonthlyStoryViewMock(...a),
  }
})

vi.mock('@/lib/services/cohort/data', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/cohort/data')>()
  return { ...actual, loadCohortData: (...a: unknown[]) => loadCohortDataMock(...a) }
})

vi.mock('@/lib/services/cohort/heat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/cohort/heat')>()
  return { ...actual, buildHeatReport: (...a: unknown[]) => buildHeatReportMock(...a) }
})

vi.mock('@/lib/services/insights/correlation-narration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/insights/correlation-narration')>()
  return { ...actual, listExistingNarrations: (...a: unknown[]) => listExistingNarrationsMock(...a) }
})

vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/rate-limit')>()
  return {
    ...actual,
    checkRateLimit: (...a: unknown[]) => checkRateLimitMock(...a),
  }
})

vi.mock('@/lib/security/client-ip', () => ({
  clientIpForRateLimit: (...a: unknown[]) => clientIpMock(...a),
}))

vi.mock('@/lib/supabase/service', () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      if (table !== 'venues') throw new Error(`unexpected table in test double: ${table}`)
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                id: DEMO_ID,
                name: 'Hawthorne Manor',
                slug: 'hawthorne-manor',
                is_demo: true,
              },
              error: null,
            }),
          }),
        }),
      }
    },
  }),
}))

import { GET, OPTIONS, loadDemoSnapshot, PUBLIC_DEMO_VENUE_ID } from '../route'

const DEMO_ID = '22222222-2222-2222-2222-222222222201'

// A handful of real-venue markers — the identifiers a leak would look
// like if a real venue's data ever reached this route. Mirrors the idea
// behind roster.ts's FORBIDDEN_EMAIL_FRAGMENTS, applied to this route's
// full JSON output rather than just email addresses.
const REAL_VENUE_MARKERS = [
  'rixey manor',
  'rixeymanor',
  'isadora martin-dye',
  'isadora@rixeymanor.com',
]

function assertNoRealVenueMarkers(body: unknown) {
  const serialized = JSON.stringify(body).toLowerCase()
  for (const marker of REAL_VENUE_MARKERS) {
    expect(serialized).not.toContain(marker)
  }
}

function emptyDailyList(): DailyList {
  return {
    needsReply: [],
    goingCold: [],
    toursThisWeek: [],
    highIntent: [],
    nextTourAt: null,
    generatedAt: '2026-09-14T00:00:00.000Z',
  }
}

function emptyMonthlyView(): MonthlyStoryView {
  return { panels: [], allEmpty: true, generatedAt: '2026-09-14T00:00:00.000Z' }
}

function emptyHeatReport(): HeatReport {
  return {
    totalCouples: 0,
    totalWithHeat: 0,
    meanHeat: null,
    medianHeat: null,
    bands: [],
    byLifecycle: [],
    hottestActive: [],
    coldestActive: [],
    activeWithNoHeat: 0,
  }
}

beforeEach(() => {
  loadDailyListMock.mockReset().mockResolvedValue(emptyDailyList())
  loadMonthlyStoryMock.mockReset().mockResolvedValue({})
  buildMonthlyStoryViewMock.mockReset().mockReturnValue(emptyMonthlyView())
  loadCohortDataMock.mockReset().mockResolvedValue({})
  buildHeatReportMock.mockReset().mockReturnValue(emptyHeatReport())
  listExistingNarrationsMock.mockReset().mockResolvedValue([])
  checkRateLimitMock.mockReset().mockResolvedValue({
    ok: true,
    remaining: 59,
    resetAt: new Date(Date.now() + 60_000),
  })
  clientIpMock.mockReset().mockReturnValue('203.0.113.7')
  delete process.env.PUBLIC_DEMO_ALLOWED_ORIGINS
})

afterEach(() => {
  delete process.env.PUBLIC_DEMO_ALLOWED_ORIGINS
})

function getRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('https://bloom.test/api/public/demo-snapshot', {
    method: 'GET',
    headers: new Headers(headers),
  })
}

// ---------------------------------------------------------------------------
// 1. Venue guard
// ---------------------------------------------------------------------------

describe('loadDemoSnapshot — venue guard', () => {
  function fakeClientReturning(venueRow: Record<string, unknown> | null) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: venueRow, error: null }),
          }),
        }),
      }),
    } as never
  }

  it('refuses when the configured venue id is not flagged is_demo', async () => {
    const client = fakeClientReturning({
      id: 'real-venue-id',
      name: 'Rixey Manor',
      slug: 'rixey-manor',
      is_demo: false,
    })
    const result = await loadDemoSnapshot(client, 'real-venue-id')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('not_a_demo_venue')
    // The refusal itself must not echo the real venue's name anywhere.
    assertNoRealVenueMarkers(result)
    expect(loadDailyListMock).not.toHaveBeenCalled()
  })

  it('refuses when the configured venue id does not exist at all', async () => {
    const client = fakeClientReturning(null)
    const result = await loadDemoSnapshot(client, 'missing-venue-id')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe('venue_not_found')
  })

  it('proceeds and reads the composed sources when is_demo is true', async () => {
    const client = fakeClientReturning({
      id: DEMO_ID,
      name: 'Hawthorne Manor',
      slug: 'hawthorne-manor',
      is_demo: true,
    })
    const result = await loadDemoSnapshot(client, DEMO_ID)
    expect(result.ok).toBe(true)
    expect(loadDailyListMock).toHaveBeenCalledWith(client, DEMO_ID)
    expect(loadMonthlyStoryMock).toHaveBeenCalledWith(client, DEMO_ID)
    expect(loadCohortDataMock).toHaveBeenCalledWith(client, DEMO_ID, {})
    expect(listExistingNarrationsMock).toHaveBeenCalledWith(client, DEMO_ID)
  })

  it('production config constant is the real Crestwood demo venue id, not a placeholder', () => {
    expect(PUBLIC_DEMO_VENUE_ID).toBe(DEMO_ID)
  })
})

// ---------------------------------------------------------------------------
// 2. Origin allow-list
// ---------------------------------------------------------------------------

describe('GET — origin allow-list', () => {
  it('refuses an Origin not present in PUBLIC_DEMO_ALLOWED_ORIGINS', async () => {
    process.env.PUBLIC_DEMO_ALLOWED_ORIGINS = 'https://thebloomhouse.ai'
    const res = await GET(getRequest({ origin: 'https://evil.example.com' }))
    expect(res.status).toBe(403)
    expect(checkRateLimitMock).not.toHaveBeenCalled()
  })

  it('allows an Origin present in the comma-separated allow-list and echoes it back', async () => {
    process.env.PUBLIC_DEMO_ALLOWED_ORIGINS =
      'https://thebloomhouse.ai, https://marketing.thebloomhouse.ai'
    const res = await GET(getRequest({ origin: 'https://marketing.thebloomhouse.ai' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://marketing.thebloomhouse.ai',
    )
  })

  it('lets a request with no Origin header through (server-to-server, no CORS to enforce)', async () => {
    process.env.PUBLIC_DEMO_ALLOWED_ORIGINS = 'https://thebloomhouse.ai'
    const res = await GET(getRequest())
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('refuses every Origin when PUBLIC_DEMO_ALLOWED_ORIGINS is unset', async () => {
    const res = await GET(getRequest({ origin: 'https://thebloomhouse.ai' }))
    expect(res.status).toBe(403)
  })

  it('OPTIONS preflight mirrors the same allow-list', async () => {
    process.env.PUBLIC_DEMO_ALLOWED_ORIGINS = 'https://thebloomhouse.ai'
    const allowed = OPTIONS(getRequest({ origin: 'https://thebloomhouse.ai' }))
    expect(allowed.status).toBe(204)
    const refused = OPTIONS(getRequest({ origin: 'https://evil.example.com' }))
    expect(refused.status).toBe(403)
  })
})

// ---------------------------------------------------------------------------
// 3. Rate limiter wiring
// ---------------------------------------------------------------------------

describe('GET — rate limiting', () => {
  it('calls the durable limiter with a generous per-IP bucket', async () => {
    await GET(getRequest())
    expect(checkRateLimitMock).toHaveBeenCalledWith({
      key: 'public-demo-snapshot:203.0.113.7',
      limit: 60,
      windowSec: 60,
    })
  })

  it('returns 429 with Retry-After when the limiter says no', async () => {
    const resetAt = new Date(Date.now() + 12_000)
    checkRateLimitMock.mockResolvedValue({ ok: false, remaining: 0, resetAt })
    const res = await GET(getRequest())
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// 4. Response shape + no real-venue markers
// ---------------------------------------------------------------------------

describe('GET — response shape', () => {
  beforeEach(() => {
    const daily: DailyList = {
      needsReply: [
        { id: 'c1', names: 'Amara Ashcombe & Theo Beaumont' },
        { id: 'c2', names: 'Nadia Cardew & Kwame Delacroix' },
        { id: 'c3', names: 'Priya Eastwick & Rafael Fairholme' },
        { id: 'c4', names: 'Imani Gallow & Bastian Hartsell' },
      ],
      goingCold: [{ id: 'c5', names: 'Lucia Ilminster & Idris Jarrow' }],
      toursThisWeek: [
        { id: 't1', coupleId: 'c1', scheduledAt: '2026-09-20T15:00:00.000Z', names: 'Amara Ashcombe & Theo Beaumont' },
        { id: 't2', coupleId: 'c2', scheduledAt: '2026-09-21T15:00:00.000Z', names: 'Nadia Cardew & Kwame Delacroix' },
      ],
      highIntent: [
        { id: 'c1', names: 'Amara Ashcombe & Theo Beaumont' },
        { id: 'c2', names: 'Nadia Cardew & Kwame Delacroix' },
        { id: 'c3', names: 'Priya Eastwick & Rafael Fairholme' },
        { id: 'c4', names: 'Imani Gallow & Bastian Hartsell' },
        { id: 'c5', names: 'Lucia Ilminster & Idris Jarrow' },
      ],
      nextTourAt: '2026-09-20T15:00:00.000Z',
      generatedAt: '2026-09-14T00:00:00.000Z',
    }
    loadDailyListMock.mockResolvedValue(daily)

    const monthlyView: MonthlyStoryView = {
      panels: [
        {
          key: 'response-time',
          title: 'How fast you answer',
          blurb: 'blurb',
          headline: 'Your typical first reply goes out in 2 hours.',
          isFinding: true,
          rows: [{ key: 'median', label: 'Typical first reply', value: '2 hours', note: 'Measured across 40 couples.', dim: false, standout: true }],
          empty: null,
          provenance: 'getCohortFunnel',
          href: '/intel/cohort',
          hrefLabel: 'See more',
        },
      ],
      allEmpty: false,
      generatedAt: '2026-09-14T00:00:00.000Z',
    }
    buildMonthlyStoryViewMock.mockReturnValue(monthlyView)

    const heatReport: HeatReport = {
      totalCouples: 50,
      totalWithHeat: 48,
      meanHeat: 42.1,
      medianHeat: 40,
      bands: [
        { label: 'Cold', min: 0, max: 19, count: 10 },
        { label: 'Cool', min: 20, max: 39, count: 15 },
        { label: 'Warm', min: 40, max: 59, count: 12 },
        { label: 'Hot', min: 60, max: 79, count: 8 },
        { label: 'On fire', min: 80, max: null, count: 3 },
      ],
      byLifecycle: [],
      hottestActive: [],
      coldestActive: [],
      activeWithNoHeat: 2,
    }
    buildHeatReportMock.mockReturnValue(heatReport)

    const narrations: NarratedCorrelation[] = Array.from({ length: 5 }, (_, i) => ({
      id: `n${i}`,
      correlationId: `corr${i}`,
      channelA: 'fred_mortgage_rate',
      channelB: 'tours',
      channelALabel: 'Mortgage rate',
      channelBLabel: 'Tours',
      lagDays: 14,
      r: 0.5 + i * 0.01,
      pValue: 0.01,
      weakSignal: false,
      title: `Narration ${i}`,
      body: `Mortgage rate moved with tours, lag 14 days (case ${i}).`,
      action: null,
      confidence: 0.7,
      cached: true,
      createdAt: '2026-09-01T00:00:00.000Z',
      seriesA: [],
      seriesB: [],
      signalClass: 'macro',
    }))
    listExistingNarrationsMock.mockResolvedValue(narrations)
  })

  it('caps each /today block at three rows but reports the true count', async () => {
    const res = await GET(getRequest())
    const body = await res.json()
    expect(body.today.needsReply.count).toBe(4)
    expect(body.today.needsReply.topRows).toHaveLength(3)
    expect(body.today.highIntent.count).toBe(5)
    expect(body.today.highIntent.topRows).toHaveLength(3)
    expect(body.today.goingCold.count).toBe(1)
    expect(body.today.goingCold.topRows).toHaveLength(1)
    expect(body.today.toursThisWeek.topRows[0]).toMatchObject({
      id: 't1',
      scheduledAt: '2026-09-20T15:00:00.000Z',
    })
  })

  it('caps insight narrations at three', async () => {
    const res = await GET(getRequest())
    const body = await res.json()
    expect(body.insights).toHaveLength(3)
  })

  it('carries the monthly-story panels and heat bands through unmodified', async () => {
    const res = await GET(getRequest())
    const body = await res.json()
    expect(body.monthlyStory).toHaveLength(1)
    expect(body.monthlyStory[0].headline).toBe('Your typical first reply goes out in 2 hours.')
    expect(body.heat.bands).toHaveLength(5)
    expect(body.heat.bands[4]).toMatchObject({ label: 'On fire', count: 3 })
  })

  it('includes generated_at and next_refresh_at five minutes apart, and the cache header', async () => {
    const res = await GET(getRequest())
    const body = await res.json()
    expect(body.generated_at).toBeTruthy()
    expect(body.next_refresh_at).toBeTruthy()
    const deltaMs = Date.parse(body.next_refresh_at) - Date.parse(body.generated_at)
    expect(deltaMs).toBe(300_000)
    expect(res.headers.get('cache-control')).toBe(
      'public, s-maxage=300, stale-while-revalidate=600',
    )
  })

  it('names in the response are the demo roster names as stored, verbatim', async () => {
    const res = await GET(getRequest())
    const body = await res.json()
    expect(body.today.needsReply.topRows[0].names).toBe('Amara Ashcombe & Theo Beaumont')
  })

  it('carries no real-venue marker anywhere in the payload', async () => {
    const res = await GET(getRequest())
    const body = await res.json()
    assertNoRealVenueMarkers(body)
  })
})
