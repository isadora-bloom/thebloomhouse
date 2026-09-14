/**
 * Benchmark view-model tests (NOVEMBER-PLAN.md wave 8, W56).
 *
 * The builder is pure, so these are driven from hand-built results with
 * no database anywhere near them. What they hold in place: the blank page
 * below the threshold says how many venues there are, the demo label
 * shows, percentiles read as positions rather than second percentages,
 * and nothing a peer could be identified by survives the formatting.
 */
import { describe, it, expect } from 'vitest'
import type {
  BenchmarkComparison,
  BenchmarkMetricKey,
  VenueBenchmark,
} from '@/lib/services/cohort/benchmark'
import { buildBenchmarkView, ordinal } from '../benchmark-view'

const VENUE = '11111111-1111-1111-1111-1111111111aa'

function comparison(
  key: BenchmarkMetricKey,
  over: Partial<BenchmarkComparison> = {},
): BenchmarkComparison {
  return {
    key,
    label: 'Enquiry to tour',
    question: 'Of the couples who enquire, how many come and look round?',
    unit: 'percent',
    higherIsBetter: true,
    method: 'Read straight off the funnel.',
    you: { value: 0.5, n: 40, enoughData: true },
    peerCount: 4,
    peerMedian: 0.3,
    peerP25: 0.25,
    peerP75: 0.4,
    percentile: 90,
    suppressed: false,
    suppressedReason: null,
    ...over,
  }
}

function result(over: Partial<VenueBenchmark> = {}): VenueBenchmark {
  return {
    venueId: VENUE,
    mode: 'real',
    demoPeers: false,
    peerCount: 4,
    minPeers: 3,
    enoughPeers: true,
    qualifyingVenueCount: 5,
    comparisons: [comparison('inquiry_to_tour')],
    generatedAt: '2026-09-14T10:00:00.000Z',
    ...over,
  }
}

describe('ordinal', () => {
  it('reads a percentile as a position', () => {
    expect(ordinal(1)).toBe('1st')
    expect(ordinal(2)).toBe('2nd')
    expect(ordinal(3)).toBe('3rd')
    expect(ordinal(4)).toBe('4th')
    expect(ordinal(11)).toBe('11th')
    expect(ordinal(12)).toBe('12th')
    expect(ordinal(13)).toBe('13th')
    expect(ordinal(21)).toBe('21st')
    expect(ordinal(100)).toBe('100th')
  })
})

describe('buildBenchmarkView', () => {
  it('says how many venues there are when there are not enough, and shows no rows', () => {
    const view = buildBenchmarkView(
      result({ enoughPeers: false, peerCount: 1, comparisons: [] }),
    )
    expect(view.enoughPeers).toBe(false)
    expect(view.rows).toHaveLength(0)
    expect(view.gateMessage).toContain('1 other venue')
    expect(view.gateMessage).toContain('3 are needed')
    // The message names what would change it, so it reads as a waiting
    // condition rather than a broken page.
    expect(view.gateMessage).toMatch(/finishing setup/i)
  })

  it('counts down correctly with two of three peers', () => {
    const view = buildBenchmarkView(result({ enoughPeers: false, peerCount: 2, comparisons: [] }))
    expect(view.gateMessage).toContain('2 other venues')
    expect(view.gateMessage).toContain('One more venue')
  })

  it('labels demo peers visibly', () => {
    const view = buildBenchmarkView(result({ demoPeers: true, mode: 'demo' }))
    expect(view.demoPeers).toBe(true)
    expect(view.demoLabel).toMatch(/demo peers/i)
    expect(view.methodNote).toMatch(/sample account/i)
  })

  it('says nothing about demo peers for a real venue', () => {
    const view = buildBenchmarkView(result())
    expect(view.demoLabel).toBeNull()
  })

  it('formats each unit the way an owner would read it', () => {
    const view = buildBenchmarkView(
      result({
        comparisons: [
          comparison('inquiry_to_tour', { unit: 'percent', you: { value: 0.42, n: 40, enoughData: true } }),
          comparison('response_hours', {
            unit: 'hours',
            higherIsBetter: false,
            you: { value: 3.5, n: 40, enoughData: true },
            peerMedian: 0.5,
            peerP25: 0.25,
            peerP75: 72,
          }),
          comparison('review_trend', {
            unit: 'points',
            you: { value: 0.25, n: 40, enoughData: true },
            peerMedian: 0,
            peerP25: -0.1,
            peerP75: 0.2,
          }),
        ],
      }),
    )
    expect(view.rows[0]!.yourValue).toBe('42%')
    expect(view.rows[1]!.yourValue).toBe('3.5 hrs')
    expect(view.rows[1]!.peerMedian).toBe('30 min')
    expect(view.rows[1]!.peerRange).toBe('15 min to 3.0 days')
    expect(view.rows[2]!.yourValue).toBe('+0.25')
    expect(view.rows[2]!.peerMedian).toBe('flat')
  })

  it('withholds rather than drawing a zero when the venue has no number', () => {
    const view = buildBenchmarkView(
      result({
        comparisons: [
          comparison('tour_to_booked', {
            you: { value: null, n: 0, enoughData: false, reason: 'no_data' },
            percentile: null,
          }),
        ],
      }),
    )
    const row = view.rows[0]!
    expect(row.yourValue).not.toBe('0%')
    expect(row.yourDim).toBe(true)
    expect(row.yourNote).toMatch(/nothing on file/i)
    expect(row.percentileLabel).toBeNull()
    expect(row.standingTone).toBe('unknown')
  })

  it('says a figure could not be read without repeating the database back at the operator', () => {
    const view = buildBenchmarkView(
      result({
        comparisons: [
          comparison('response_hours', {
            you: { value: null, n: 0, enoughData: false, reason: 'read_failed' },
            percentile: null,
          }),
        ],
      }),
    )
    expect(view.rows[0]!.yourNote).toMatch(/could not be read/i)
    expect(view.rows[0]!.yourNote).not.toMatch(/error|exception|supabase|postgres/i)
  })

  it('shows a suppressed row as blank with a reason, not as a zero', () => {
    const view = buildBenchmarkView(
      result({
        comparisons: [
          comparison('review_trend', {
            suppressed: true,
            suppressedReason: 'Only 2 other venues can answer this.',
            peerCount: 2,
            peerMedian: null,
            peerP25: null,
            peerP75: null,
            percentile: null,
          }),
        ],
      }),
    )
    const row = view.rows[0]!
    expect(row.peerMedian).not.toMatch(/\d/)
    expect(row.peerRange).not.toMatch(/\d/)
    expect(row.percentileLabel).toBeNull()
    expect(row.standing).toContain('Only 2 other venues')
  })

  it('calls a top-quarter position ahead and a bottom-quarter position behind', () => {
    const ahead = buildBenchmarkView(result({ comparisons: [comparison('inquiry_to_tour', { percentile: 90 })] }))
    expect(ahead.rows[0]!.standingTone).toBe('ahead')
    expect(ahead.rows[0]!.percentileLabel).toBe('90th')

    const behind = buildBenchmarkView(result({ comparisons: [comparison('inquiry_to_tour', { percentile: 10 })] }))
    expect(behind.rows[0]!.standingTone).toBe('behind')
    expect(behind.rows[0]!.standing).toContain('90%')

    const middle = buildBenchmarkView(result({ comparisons: [comparison('inquiry_to_tour', { percentile: 50 })] }))
    expect(middle.rows[0]!.standingTone).toBe('level')
  })

  it('says which direction is better, so a low reply time does not read as a bad score', () => {
    const view = buildBenchmarkView(
      result({
        comparisons: [
          comparison('response_hours', {
            unit: 'hours',
            higherIsBetter: false,
            percentile: 95,
          }),
        ],
      }),
    )
    expect(view.rows[0]!.standing).toContain('lower is better')
    expect(view.rows[0]!.standingTone).toBe('ahead')
  })

  it('writes a method note that admits no venue is named', () => {
    const view = buildBenchmarkView(result())
    expect(view.methodNote).toMatch(/no venue is named/i)
    expect(view.methodNote).toMatch(/median/i)
    expect(view.methodNote).toContain('3')
  })

  it('carries nothing through formatting that could identify a peer', () => {
    const view = buildBenchmarkView(result())
    const serialised = JSON.stringify(view)
    // The only ids or names that could exist here are the caller's, and
    // the view does not even carry that.
    expect(serialised).not.toContain(VENUE)
    expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)
  })
})
