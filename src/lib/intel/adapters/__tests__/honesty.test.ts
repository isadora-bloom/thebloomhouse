/**
 * Honesty rail — the contract that a below-floor number never renders as
 * a confident one.
 *
 * These are the assertions that stop the doctrine eroding: if someone
 * later "tidies up" renderDistribution so an insufficient sample prints
 * its number bare, these fail.
 */

import { describe, it, expect } from 'vitest'
import type { Distribution } from '@/lib/intel/canonical'
import {
  WITHHELD,
  emptyDistribution,
  renderDistribution,
  sufficiencySummary,
} from '../honesty'

function dist(over: Partial<Distribution>): Distribution {
  return { value: null, n: 0, enoughData: false, reason: 'no_data', ...over }
}

describe('renderDistribution', () => {
  it('renders a sufficient value with its sample size and no dimming', () => {
    const r = renderDistribution(dist({ value: 0.24, n: 50, enoughData: true, reason: undefined }), 'percent')
    expect(r.text).toBe('24%')
    expect(r.n).toBe(50)
    expect(r.enoughData).toBe(true)
    expect(r.dim).toBe(false)
    expect(r.reason).toBeNull()
    expect(r.title).toContain('50 couples')
  })

  it('withholds a below-floor value by default and says why', () => {
    const r = renderDistribution(
      dist({ value: 0.5, n: 2, enoughData: false, reason: 'insufficient_sample' }),
      'percent',
    )
    expect(r.text).toBe(WITHHELD)
    expect(r.text).not.toBe('50%')
    expect(r.dim).toBe(true)
    expect(r.reason).toContain('reporting floor')
    expect(r.title).toContain('n=2')
  })

  it('prints the below-floor value only when the caller opts in, still dimmed', () => {
    const r = renderDistribution(
      dist({ value: 0.5, n: 2, enoughData: false, reason: 'insufficient_sample' }),
      'percent',
      { showWithheldValue: true },
    )
    expect(r.text).toBe('50%')
    expect(r.dim).toBe(true)
    expect(r.enoughData).toBe(false)
  })

  it('never turns a null into a zero, even when the caller opts in', () => {
    const r = renderDistribution(
      dist({ value: null, n: 12, enoughData: false, reason: 'zero_denominator' }),
      'percent',
      { showWithheldValue: true },
    )
    expect(r.text).toBe(WITHHELD)
    expect(r.text).not.toBe('0%')
    expect(r.reason).toContain('denominator is zero')
  })

  it('distinguishes no data from a zero denominator in the copy', () => {
    const noData = renderDistribution(dist({ value: null, n: 0, reason: 'no_data' }))
    const zeroDenom = renderDistribution(
      dist({ value: null, n: 9, reason: 'zero_denominator' }),
    )
    expect(noData.reason).not.toBe(zeroDenom.reason)
  })

  it('formats money, ratio and plain numbers distinctly', () => {
    const base = { n: 30, enoughData: true, reason: undefined }
    expect(renderDistribution(dist({ ...base, value: 1234.6 }), 'money').text).toBe('$1,235')
    expect(renderDistribution(dist({ ...base, value: 3.456 }), 'ratio').text).toBe('3.46x')
    expect(renderDistribution(dist({ ...base, value: 1234.5 }), 'number').text).toBe('1,234.5')
  })
})

describe('emptyDistribution', () => {
  it('is honest-empty, not zero', () => {
    const d = emptyDistribution()
    expect(d.value).toBeNull()
    expect(d.n).toBe(0)
    expect(d.enoughData).toBe(false)
    expect(d.reason).toBe('no_data')
  })
})

describe('sufficiencySummary', () => {
  it('counts how many cells cleared their floor and the largest sample', () => {
    const s = sufficiencySummary([
      dist({ value: 0.1, n: 40, enoughData: true }),
      dist({ value: 0.2, n: 9, enoughData: true }),
      dist({ value: 0.3, n: 3, enoughData: false }),
      dist({ value: null, n: 0 }),
    ])
    expect(s.total).toBe(4)
    expect(s.enough).toBe(2)
    expect(s.anyEnough).toBe(true)
    expect(s.maxN).toBe(40)
  })

  it('reports anyEnough false when nothing has cleared its floor', () => {
    const s = sufficiencySummary([dist({ n: 5 }), dist({ n: 2 })])
    expect(s.anyEnough).toBe(false)
    expect(s.maxN).toBe(5)
  })

  it('handles an empty set without pretending', () => {
    const s = sufficiencySummary([])
    expect(s).toEqual({ total: 0, enough: 0, anyEnough: false, maxN: 0 })
  })
})
