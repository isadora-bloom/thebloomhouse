/**
 * Unit tests for plan-tiers.ts — pure functions, no mocks needed.
 *
 * Covers:
 *   - tierMeetsMinimum: all 9 tier-pair combinations
 *   - tierHasFeature: cumulative access at each tier
 *   - minTierForFeature: returns the correct minimum tier
 *   - TIER_RANK: strict ordering
 */

import { describe, it, expect } from 'vitest'
import {
  tierMeetsMinimum,
  tierHasFeature,
  minTierForFeature,
  TIER_RANK,
  type PlanTier,
} from '@/lib/auth/plan-tiers'

// ---------------------------------------------------------------------------
// TIER_RANK ordering
// ---------------------------------------------------------------------------

describe('TIER_RANK', () => {
  it('has starter < intelligence < enterprise', () => {
    expect(TIER_RANK.starter).toBeLessThan(TIER_RANK.intelligence)
    expect(TIER_RANK.intelligence).toBeLessThan(TIER_RANK.enterprise)
  })

  it('assigns non-negative integers to every tier', () => {
    for (const rank of Object.values(TIER_RANK)) {
      expect(rank).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(rank)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// tierMeetsMinimum — exhaustive 3×3 matrix
// ---------------------------------------------------------------------------

describe('tierMeetsMinimum', () => {
  // Rows = current tier, Cols = required tier
  const matrix: Array<{ current: PlanTier; required: PlanTier; expected: boolean }> = [
    // starter vs all
    { current: 'starter', required: 'starter', expected: true },
    { current: 'starter', required: 'intelligence', expected: false },
    { current: 'starter', required: 'enterprise', expected: false },
    // intelligence vs all
    { current: 'intelligence', required: 'starter', expected: true },
    { current: 'intelligence', required: 'intelligence', expected: true },
    { current: 'intelligence', required: 'enterprise', expected: false },
    // enterprise vs all
    { current: 'enterprise', required: 'starter', expected: true },
    { current: 'enterprise', required: 'intelligence', expected: true },
    { current: 'enterprise', required: 'enterprise', expected: true },
  ]

  for (const { current, required, expected } of matrix) {
    it(`tierMeetsMinimum('${current}', '${required}') → ${expected}`, () => {
      expect(tierMeetsMinimum(current, required)).toBe(expected)
    })
  }

  it('enterprise meets starter minimum', () => {
    expect(tierMeetsMinimum('enterprise', 'starter')).toBe(true)
  })

  it('enterprise meets intelligence minimum', () => {
    expect(tierMeetsMinimum('enterprise', 'intelligence')).toBe(true)
  })

  it('starter does not meet intelligence minimum', () => {
    expect(tierMeetsMinimum('starter', 'intelligence')).toBe(false)
  })

  it('intelligence meets intelligence minimum (equal tier)', () => {
    expect(tierMeetsMinimum('intelligence', 'intelligence')).toBe(true)
  })

  it('enterprise meets enterprise minimum (equal tier)', () => {
    expect(tierMeetsMinimum('enterprise', 'enterprise')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// tierHasFeature — cumulative access
// ---------------------------------------------------------------------------

describe('tierHasFeature', () => {
  // Starter-only features
  it('starter has access to "agent" feature', () => {
    expect(tierHasFeature('starter', 'agent')).toBe(true)
  })

  it('intelligence has access to "agent" (cumulative from starter)', () => {
    expect(tierHasFeature('intelligence', 'agent')).toBe(true)
  })

  it('enterprise has access to "agent" (cumulative from starter)', () => {
    expect(tierHasFeature('enterprise', 'agent')).toBe(true)
  })

  // Intelligence-tier features
  it('intelligence has access to "sage" feature', () => {
    expect(tierHasFeature('intelligence', 'sage')).toBe(true)
  })

  it('enterprise has access to "sage" (cumulative from intelligence)', () => {
    expect(tierHasFeature('enterprise', 'sage')).toBe(true)
  })

  it('starter does NOT have access to "sage"', () => {
    expect(tierHasFeature('starter', 'sage')).toBe(false)
  })

  // Enterprise-only features
  it('enterprise has access to "multi_venue" feature', () => {
    expect(tierHasFeature('enterprise', 'multi_venue')).toBe(true)
  })

  it('intelligence does NOT have access to "multi_venue"', () => {
    expect(tierHasFeature('intelligence', 'multi_venue')).toBe(false)
  })

  it('starter does NOT have access to "multi_venue"', () => {
    expect(tierHasFeature('starter', 'multi_venue')).toBe(false)
  })

  it('returns false for a completely unknown feature at any tier', () => {
    expect(tierHasFeature('enterprise', 'feature_that_does_not_exist')).toBe(false)
    expect(tierHasFeature('starter', 'feature_that_does_not_exist')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// minTierForFeature
// ---------------------------------------------------------------------------

describe('minTierForFeature', () => {
  it('returns "starter" for a starter feature', () => {
    expect(minTierForFeature('agent')).toBe('starter')
  })

  it('returns "starter" for "portal" (starter feature)', () => {
    expect(minTierForFeature('portal')).toBe('starter')
  })

  it('returns "intelligence" for "sage"', () => {
    expect(minTierForFeature('sage')).toBe('intelligence')
  })

  it('returns "intelligence" for "couple_portal"', () => {
    expect(minTierForFeature('couple_portal')).toBe('intelligence')
  })

  it('returns "enterprise" for "multi_venue"', () => {
    expect(minTierForFeature('multi_venue')).toBe('enterprise')
  })

  it('returns "enterprise" for a completely unknown feature (fail-closed)', () => {
    expect(minTierForFeature('totally_unknown_feature')).toBe('enterprise')
  })
})
