/**
 * Cross-venue benchmark tests (NOVEMBER-PLAN.md wave 8, W56).
 *
 * Five things are worth pinning here, and they are the five things that
 * would hurt if they broke quietly:
 *   1. the percentile maths, including ties and the lower-is-better case;
 *   2. anonymisation, tested by grepping the whole returned object for
 *      any peer id or name rather than by checking named fields, because
 *      a leak would arrive in a field nobody thought to check;
 *   3. the three-peer threshold, both directions;
 *   4. demo mode comparing demo venues with each other;
 *   5. venue isolation: a venue is never its own peer, and a venue that
 *      has not finished setting up is nobody's peer.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase } from '@/lib/intel/tool-sources/__tests__/fake-supabase'
import {
  BENCHMARK_METRICS,
  BENCHMARK_MIN_PEERS,
  benchmarkPeerSet,
  buildVenueBenchmark,
  percentileRank,
  summarisePeerMetric,
  type BenchmarkMetricKey,
  type BenchmarkMetricValue,
} from '../benchmark'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REAL_A = '11111111-1111-1111-1111-1111111111aa'
const REAL_B = '11111111-1111-1111-1111-1111111111bb'
const REAL_C = '11111111-1111-1111-1111-1111111111cc'
const REAL_D = '11111111-1111-1111-1111-1111111111dd'
/** A real venue that has not finished setting up. Never a peer. */
const HALF_SET_UP = '11111111-1111-1111-1111-1111111111ee'

const DEMO_1 = '22222222-2222-2222-2222-222222222201'
const DEMO_2 = '22222222-2222-2222-2222-222222222202'
const DEMO_3 = '22222222-2222-2222-2222-222222222203'
const DEMO_4 = '22222222-2222-2222-2222-222222222204'

const PEER_NAME = 'Ravensworth Hall'

interface FakeVenue {
  id: string
  is_demo: boolean
  onboarded: boolean
  name: string
}

const WORLD: FakeVenue[] = [
  { id: REAL_A, is_demo: false, onboarded: true, name: 'Caller Venue' },
  { id: REAL_B, is_demo: false, onboarded: true, name: PEER_NAME },
  { id: REAL_C, is_demo: false, onboarded: true, name: 'Barnfield Court' },
  { id: REAL_D, is_demo: false, onboarded: true, name: 'Ashcombe Barn' },
  { id: HALF_SET_UP, is_demo: false, onboarded: false, name: 'Not Ready Manor' },
  { id: DEMO_1, is_demo: true, onboarded: true, name: 'Hawthorne Manor' },
  { id: DEMO_2, is_demo: true, onboarded: true, name: 'Crestwood Farm' },
  { id: DEMO_3, is_demo: true, onboarded: true, name: 'The Glass House' },
  { id: DEMO_4, is_demo: true, onboarded: true, name: 'Rose Hill Gardens' },
]

/** A supabase fake that answers the two peer-set queries from `world`
 *  and returns no spine rows for anything else. */
function peerSetSupabase(world: FakeVenue[] = WORLD) {
  return makeFakeSupabase((table) => {
    if (table === 'venues') {
      return { data: world.map((v) => ({ id: v.id, is_demo: v.is_demo })) }
    }
    if (table === 'venue_config') {
      return {
        data: world.map((v) => ({ venue_id: v.id, onboarding_completed: v.onboarded })),
      }
    }
    return { data: [] }
  })
}

function value(v: number | null, n = 40): BenchmarkMetricValue {
  return v === null
    ? { value: null, n, enoughData: false, reason: 'no_data' }
    : { value: v, n, enoughData: true }
}

// ---------------------------------------------------------------------------
// 1. Percentile maths
// ---------------------------------------------------------------------------

describe('percentileRank', () => {
  it('reports the share of peers the value beats when higher is better', () => {
    expect(percentileRank(0.5, [0.1, 0.2, 0.3, 0.4], true)).toBe(100)
    expect(percentileRank(0.05, [0.1, 0.2, 0.3, 0.4], true)).toBe(0)
    expect(percentileRank(0.25, [0.1, 0.2, 0.3, 0.4], true)).toBe(50)
  })

  it('inverts for lower-is-better metrics, so a percentile always reads the same way', () => {
    // Two hours against peers of four, six and eight: fastest of the lot.
    expect(percentileRank(2, [4, 6, 8], false)).toBe(100)
    expect(percentileRank(9, [4, 6, 8], false)).toBe(0)
  })

  it('splits ties in half rather than handing everyone the top spot', () => {
    // One peer identical, one worse: 1 ahead + half of 1 tie, over 2.
    expect(percentileRank(5, [5, 1], true)).toBe(75)
    // Everyone identical lands mid-table, not at 100.
    expect(percentileRank(5, [5, 5, 5], true)).toBe(50)
  })

  it('has nothing to say with no peers', () => {
    expect(percentileRank(5, [], true)).toBeNull()
  })
})

describe('summarisePeerMetric', () => {
  it('gives the peer median and both quartiles above the threshold', () => {
    const row = summarisePeerMetric('inquiry_to_tour', value(0.5), [0.2, 0.3, 0.4, 0.6])
    expect(row.suppressed).toBe(false)
    expect(row.peerCount).toBe(4)
    expect(row.peerMedian).toBeCloseTo(0.35, 5)
    expect(row.peerP25).toBeCloseTo(0.275, 5)
    expect(row.peerP75).toBeCloseTo(0.45, 5)
    expect(row.percentile).toBe(75)
  })

  it('suppresses a metric too few peers can answer, even when the set is big enough', () => {
    const row = summarisePeerMetric('review_trend', value(0.4), [0.1, 0.2])
    expect(row.suppressed).toBe(true)
    expect(row.peerMedian).toBeNull()
    expect(row.peerP25).toBeNull()
    expect(row.peerP75).toBeNull()
    expect(row.percentile).toBeNull()
    expect(row.suppressedReason).toContain('2')
  })

  it('keeps the caller placeable-but-unplaced when it has no number of its own', () => {
    const row = summarisePeerMetric('tour_to_booked', value(null, 0), [0.1, 0.2, 0.3])
    expect(row.suppressed).toBe(false)
    expect(row.peerMedian).toBeCloseTo(0.2, 5)
    expect(row.percentile).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Peer set: isolation, demo mode, the onboarding gate
// ---------------------------------------------------------------------------

describe('benchmarkPeerSet', () => {
  it('never returns the caller as its own peer', async () => {
    for (const id of [REAL_A, REAL_B, REAL_C, DEMO_1, DEMO_4]) {
      const set = await benchmarkPeerSet(id, peerSetSupabase())
      expect(set.peerVenueIds).not.toContain(id)
    }
  })

  it('excludes demo venues from a real venue’s peers', async () => {
    const set = await benchmarkPeerSet(REAL_A, peerSetSupabase())
    expect(set.mode).toBe('real')
    expect(set.peerVenueIds.sort()).toEqual([REAL_B, REAL_C, REAL_D].sort())
    for (const demo of [DEMO_1, DEMO_2, DEMO_3, DEMO_4]) {
      expect(set.peerVenueIds).not.toContain(demo)
    }
  })

  it('excludes a venue that has not finished setting up', async () => {
    const set = await benchmarkPeerSet(REAL_A, peerSetSupabase())
    expect(set.peerVenueIds).not.toContain(HALF_SET_UP)
  })

  it('compares a demo venue against the other demo venues', async () => {
    const set = await benchmarkPeerSet(DEMO_1, peerSetSupabase())
    expect(set.mode).toBe('demo')
    expect(set.callerIsDemo).toBe(true)
    expect(set.peerVenueIds.sort()).toEqual([DEMO_2, DEMO_3, DEMO_4].sort())
    for (const real of [REAL_A, REAL_B, REAL_C, REAL_D, HALF_SET_UP]) {
      expect(set.peerVenueIds).not.toContain(real)
    }
  })

  it('turns on by itself once a third real venue finishes setting up', async () => {
    const twoPeers = WORLD.filter((v) => v.id !== REAL_D)
    const before = await benchmarkPeerSet(REAL_A, peerSetSupabase(twoPeers))
    expect(before.peerVenueIds).toHaveLength(2)
    expect(before.peerVenueIds.length < BENCHMARK_MIN_PEERS).toBe(true)

    const after = await benchmarkPeerSet(REAL_A, peerSetSupabase(WORLD))
    expect(after.peerVenueIds).toHaveLength(3)
    expect(after.peerVenueIds.length >= BENCHMARK_MIN_PEERS).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 3. The whole build: threshold, anonymisation, demo mode
// ---------------------------------------------------------------------------

/** Stub the per-venue reader. Each venue gets a distinguishable number so
 *  a leak of "peer values as rows" would be visible and the medians are
 *  checkable by hand. The stub counts its calls, which is how the
 *  "reads no peer below the threshold" test is checked. */
function stubVenueValues(byVenue: Record<string, number>) {
  const calls: string[] = []
  const read = async (_supabase: SupabaseClient, venueId: string) => {
    calls.push(venueId)
    const base = byVenue[venueId] ?? 0.1
    const values = {} as Record<BenchmarkMetricKey, BenchmarkMetricValue>
    for (const m of BENCHMARK_METRICS) values[m.key] = value(base)
    return { venueId, values }
  }
  return { read, calls }
}

async function buildWith(
  callerId: string,
  byVenue: Record<string, number>,
  world: FakeVenue[] = WORLD,
) {
  const stub = stubVenueValues(byVenue)
  const result = await buildVenueBenchmark(peerSetSupabase(world), callerId, {
    readValues: stub.read,
  })
  return { result, calls: stub.calls }
}

describe('buildVenueBenchmark', () => {
  it('shows nothing and says why below three peers', async () => {
    const twoPeers = WORLD.filter((v) => v.id !== REAL_D)
    const { result } = await buildWith(
      REAL_A,
      { [REAL_A]: 0.5, [REAL_B]: 0.2, [REAL_C]: 0.3 },
      twoPeers,
    )
    expect(result.enoughPeers).toBe(false)
    expect(result.peerCount).toBe(2)
    expect(result.minPeers).toBe(3)
    for (const row of result.comparisons) {
      expect(row.suppressed).toBe(true)
      expect(row.peerMedian).toBeNull()
      expect(row.percentile).toBeNull()
    }
  })

  it('compares once three peers exist', async () => {
    const { result } = await buildWith(REAL_A, {
      [REAL_A]: 0.5,
      [REAL_B]: 0.2,
      [REAL_C]: 0.3,
      [REAL_D]: 0.4,
    })
    expect(result.enoughPeers).toBe(true)
    expect(result.peerCount).toBe(3)
    const row = result.comparisons.find((c) => c.key === 'inquiry_to_tour')!
    expect(row.suppressed).toBe(false)
    expect(row.peerMedian).toBeCloseTo(0.3, 5)
    expect(row.percentile).toBe(100)
  })

  it('never lets a peer id or name reach the returned object', async () => {
    const { result } = await buildWith(REAL_A, {
      [REAL_A]: 0.5,
      [REAL_B]: 0.2,
      [REAL_C]: 0.3,
      [REAL_D]: 0.4,
    })

    // Grep the whole thing rather than named fields: a leak would turn up
    // in a field nobody thought to assert on.
    const serialised = JSON.stringify(result)
    for (const peerId of [REAL_B, REAL_C, REAL_D, DEMO_1, HALF_SET_UP]) {
      expect(serialised).not.toContain(peerId)
    }
    expect(serialised).not.toContain(PEER_NAME)
    for (const venue of WORLD) {
      if (venue.id === REAL_A) continue
      expect(serialised).not.toContain(venue.name)
    }
    // The caller's own id is the one id that belongs here.
    expect(serialised).toContain(REAL_A)
  })

  it('exposes no single peer figure, only the middle and the quartiles', async () => {
    const { result } = await buildWith(REAL_A, {
      [REAL_A]: 0.5,
      [REAL_B]: 0.2,
      [REAL_C]: 0.3,
      [REAL_D]: 0.4,
    })
    const row = result.comparisons.find((c) => c.key === 'tour_to_booked')!
    // The three peer-derived fields are summaries, and nothing on the row
    // is a list, so there is nowhere for a raw peer value to hide.
    expect([row.peerMedian, row.peerP25, row.peerP75].every((v) => typeof v === 'number')).toBe(
      true,
    )
    expect(Object.values(row).some((v) => Array.isArray(v))).toBe(false)
  })

  it('runs the demo against the other demo venues and labels it', async () => {
    const { result } = await buildWith(DEMO_1, {
      [DEMO_1]: 0.5,
      [DEMO_2]: 0.2,
      [DEMO_3]: 0.3,
      [DEMO_4]: 0.4,
    })
    expect(result.mode).toBe('demo')
    expect(result.demoPeers).toBe(true)
    expect(result.enoughPeers).toBe(true)
    expect(result.peerCount).toBe(3)
    const serialised = JSON.stringify(result)
    for (const demo of [DEMO_2, DEMO_3, DEMO_4]) {
      expect(serialised).not.toContain(demo)
    }
  })

  it('does not read a single peer when it is below the threshold', async () => {
    const twoPeers = WORLD.filter((v) => v.id !== REAL_D)
    const { calls } = await buildWith(
      REAL_A,
      { [REAL_A]: 0.5, [REAL_B]: 0.2, [REAL_C]: 0.3 },
      twoPeers,
    )
    // Exactly one read: the caller's own. There is no reason to touch
    // another venue's rows when nothing can be shown from them.
    expect(calls).toEqual([REAL_A])
  })

  it('reads the caller and every peer once above the threshold', async () => {
    const { calls } = await buildWith(REAL_A, {
      [REAL_A]: 0.5,
      [REAL_B]: 0.2,
      [REAL_C]: 0.3,
      [REAL_D]: 0.4,
    })
    expect(calls.sort()).toEqual([REAL_A, REAL_B, REAL_C, REAL_D].sort())
  })
})
