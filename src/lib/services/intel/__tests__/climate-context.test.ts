/**
 * Unit tests for the least-squares trend added to climate-context.ts
 * (W49, wave 7). This is a pure function — no Supabase mocking needed
 * for the slope math itself; the DB-wired getVenueClimateContext path
 * is covered indirectly by the existing consumers (weekly-digest,
 * sage-intelligence, tour/prep-brief) reading `available`/`promptBlock`,
 * which this change does not alter the contract of.
 */
import { describe, it, expect } from 'vitest'
import { leastSquaresSlope } from '../climate-context'

describe('leastSquaresSlope', () => {
  it('returns null with fewer than two distinct x values', () => {
    expect(leastSquaresSlope([])).toBeNull()
    expect(leastSquaresSlope([{ x: 2020, y: 70 }])).toBeNull()
    // Same x repeated — still only one distinct x, no slope defined.
    expect(
      leastSquaresSlope([
        { x: 2020, y: 70 },
        { x: 2020, y: 72 },
      ]),
    ).toBeNull()
  })

  it('computes the exact slope for a perfect line', () => {
    // y = 2x - 3990 -> at x=2020, y=50; x=2021, y=52; ...
    const points = [
      { x: 2020, y: 50 },
      { x: 2021, y: 52 },
      { x: 2022, y: 54 },
      { x: 2023, y: 56 },
    ]
    expect(leastSquaresSlope(points)).toBeCloseTo(2, 10)
  })

  it('computes a negative slope for a cooling/drying trend', () => {
    const points = [
      { x: 2020, y: 80 },
      { x: 2021, y: 77 },
      { x: 2022, y: 74 },
      { x: 2023, y: 71 },
    ]
    expect(leastSquaresSlope(points)).toBeCloseTo(-3, 10)
  })

  it('finds the best-fit slope through noisy (non-perfectly-linear) data', () => {
    // Rising trend with noise — slope should land near +0.4/yr, not
    // be thrown off by any single point.
    const points = [
      { x: 2016, y: 74.1 },
      { x: 2017, y: 74.6 },
      { x: 2018, y: 74.3 }, // noise: dips slightly
      { x: 2019, y: 75.2 },
      { x: 2020, y: 75.9 },
    ]
    const slope = leastSquaresSlope(points)
    expect(slope).not.toBeNull()
    expect(slope as number).toBeGreaterThan(0.2)
    expect(slope as number).toBeLessThan(0.6)
  })

  it('ignores non-finite points rather than throwing', () => {
    const points = [
      { x: 2020, y: NaN },
      { x: 2021, y: 52 },
      { x: 2022, y: 54 },
    ]
    // Only 2 finite points remain after filtering NaN — still computable.
    expect(leastSquaresSlope(points)).toBeCloseTo(2, 10)
  })
})
