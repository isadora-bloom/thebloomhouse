/**
 * Heat, with the working shown.
 *
 * The score itself is already tested where it is computed. What matters
 * here is that the explanation cannot drift from the score: same
 * touchpoints in, same number, and the evidence lines describe the
 * signals that actually contributed rather than the ones that did not.
 */

import { describe, it, expect } from 'vitest'
import { computeHeatScore } from '@/lib/services/identity/heat-score'
import { buildHeatWhy } from '../heat-why'

const NOW = Date.parse('2026-09-08T12:00:00.000Z')
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

describe('buildHeatWhy', () => {
  it('reports zero and says why when nothing scored', () => {
    const why = buildHeatWhy([], NOW)
    expect(why.score).toBe(0)
    expect(why.displayScore).toBe(0)
    expect(why.contributingCount).toBe(0)
    expect(why.evidence).toEqual([])
    expect(why.reasoning).toContain('stays at zero rather than guessing')
  })

  it('agrees with computeHeatScore on the same touchpoints', () => {
    const tps = [
      { signal_tier: 'highest', occurred_at: daysAgo(2) },
      { signal_tier: 'high', occurred_at: daysAgo(20) },
      { signal_tier: 'low', occurred_at: daysAgo(1) },
    ]
    expect(buildHeatWhy(tps, NOW).score).toBe(computeHeatScore(tps, NOW))
  })

  it('excludes aggregate-only and unknown tiers from the explanation too', () => {
    const why = buildHeatWhy(
      [
        { signal_tier: 'aggregate_only', occurred_at: daysAgo(1) },
        { signal_tier: 'not_a_tier', occurred_at: daysAgo(1) },
        { signal_tier: 'high', occurred_at: daysAgo(1) },
      ],
      NOW,
    )
    expect(why.contributingCount).toBe(1)
    expect(why.evidence).toHaveLength(1)
  })

  it('orders evidence by influence, not by date', () => {
    const why = buildHeatWhy(
      [
        { signal_tier: 'low', occurred_at: daysAgo(0) },
        { signal_tier: 'highest', occurred_at: daysAgo(3) },
      ],
      NOW,
    )
    expect(why.evidence[0]).toContain('top-tier')
  })

  it('caps the evidence list but keeps the full contributing count', () => {
    const tps = Array.from({ length: 20 }, (_, i) => ({
      signal_tier: 'high',
      occurred_at: daysAgo(i),
    }))
    const why = buildHeatWhy(tps, NOW)
    expect(why.contributingCount).toBe(20)
    expect(why.evidence).toHaveLength(6)
  })

  it('buckets and labels the score the same way the badge does', () => {
    const hot = buildHeatWhy([{ signal_tier: 'highest', occurred_at: daysAgo(0) }], NOW)
    expect(hot.bucket).toBe('hot')
    expect(hot.label).toBe('Hot')
    const cool = buildHeatWhy([{ signal_tier: 'low', occurred_at: daysAgo(90) }], NOW)
    expect(cool.bucket).toBe('cool')
    expect(cool.label).toBe('Cool')
  })

  it('explains the half-life so an old signing does not look like a mistake', () => {
    const why = buildHeatWhy([{ signal_tier: 'highest', occurred_at: daysAgo(60) }], NOW)
    expect(why.reasoning).toContain('half its weight every fortnight')
  })

  it('phrases ages in words a coordinator uses', () => {
    expect(buildHeatWhy([{ signal_tier: 'high', occurred_at: daysAgo(0) }], NOW).evidence[0]).toContain('today')
    expect(buildHeatWhy([{ signal_tier: 'high', occurred_at: daysAgo(1) }], NOW).evidence[0]).toContain('yesterday')
    expect(buildHeatWhy([{ signal_tier: 'high', occurred_at: daysAgo(5) }], NOW).evidence[0]).toContain('days ago')
    expect(buildHeatWhy([{ signal_tier: 'high', occurred_at: daysAgo(30) }], NOW).evidence[0]).toContain('weeks ago')
    expect(buildHeatWhy([{ signal_tier: 'high', occurred_at: daysAgo(120) }], NOW).evidence[0]).toContain('months ago')
  })
})
