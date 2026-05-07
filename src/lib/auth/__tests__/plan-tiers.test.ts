/**
 * Unit tests for plan-tiers.ts — pure functions, no mocks needed.
 *
 * Covers (Pricing v2 — 5-tier capacity-gated model):
 *   - tierMeetsMinimum: full 5×5 tier-pair matrix
 *   - tierHasFeature: every tier has every feature post-v2 (always true)
 *   - minTierForFeature: returns 'solo' (lowest paid tier) for any feature
 *   - TIER_RANK: strict ordering across the new 5 tiers
 *   - capacityForTier: returns the per-tier capacity caps
 */

import { describe, it, expect } from 'vitest'
import {
  tierMeetsMinimum,
  tierHasFeature,
  minTierForFeature,
  capacityForTier,
  CAPACITY_LIMITS,
  TIER_RANK,
  TIER_DISPLAY,
  type PlanTier,
} from '@/lib/auth/plan-tiers'

const ALL_TIERS: PlanTier[] = ['pre_opening', 'solo', 'growth', 'multi', 'enterprise']

// ---------------------------------------------------------------------------
// TIER_RANK ordering
// ---------------------------------------------------------------------------

describe('TIER_RANK', () => {
  it('orders pre_opening < solo < growth < multi < enterprise', () => {
    expect(TIER_RANK.pre_opening).toBeLessThan(TIER_RANK.solo)
    expect(TIER_RANK.solo).toBeLessThan(TIER_RANK.growth)
    expect(TIER_RANK.growth).toBeLessThan(TIER_RANK.multi)
    expect(TIER_RANK.multi).toBeLessThan(TIER_RANK.enterprise)
  })

  it('assigns non-negative integers to every tier', () => {
    for (const rank of Object.values(TIER_RANK)) {
      expect(rank).toBeGreaterThanOrEqual(0)
      expect(Number.isInteger(rank)).toBe(true)
    }
  })

  it('has TIER_DISPLAY entries for every tier', () => {
    for (const tier of ALL_TIERS) {
      expect(TIER_DISPLAY[tier]).toBeDefined()
      expect(TIER_DISPLAY[tier].name.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// tierMeetsMinimum — exhaustive 5×5 matrix
// ---------------------------------------------------------------------------

describe('tierMeetsMinimum', () => {
  // Build the matrix programmatically: a tier meets a required tier iff
  // its rank is >= the required rank.
  const matrix: Array<{ current: PlanTier; required: PlanTier; expected: boolean }> = []
  for (const current of ALL_TIERS) {
    for (const required of ALL_TIERS) {
      matrix.push({
        current,
        required,
        expected: TIER_RANK[current] >= TIER_RANK[required],
      })
    }
  }

  for (const { current, required, expected } of matrix) {
    it(`tierMeetsMinimum('${current}', '${required}') → ${expected}`, () => {
      expect(tierMeetsMinimum(current, required)).toBe(expected)
    })
  }

  it('enterprise meets every minimum', () => {
    for (const required of ALL_TIERS) {
      expect(tierMeetsMinimum('enterprise', required)).toBe(true)
    }
  })

  it('pre_opening only meets pre_opening', () => {
    expect(tierMeetsMinimum('pre_opening', 'pre_opening')).toBe(true)
    expect(tierMeetsMinimum('pre_opening', 'solo')).toBe(false)
    expect(tierMeetsMinimum('pre_opening', 'enterprise')).toBe(false)
  })

  it('every tier meets itself (reflexive)', () => {
    for (const tier of ALL_TIERS) {
      expect(tierMeetsMinimum(tier, tier)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// tierHasFeature — pricing v2: every tier has every feature
// ---------------------------------------------------------------------------

describe('tierHasFeature (pricing v2)', () => {
  it('returns true for every tier × every feature (capacity is the only differentiator)', () => {
    const sampleFeatures = ['agent', 'sage', 'multi_venue', 'totally_made_up_feature']
    for (const tier of ALL_TIERS) {
      for (const feature of sampleFeatures) {
        expect(tierHasFeature(tier, feature)).toBe(true)
      }
    }
  })
})

// ---------------------------------------------------------------------------
// minTierForFeature — pricing v2: lowest paid tier (solo) for any feature
// ---------------------------------------------------------------------------

describe('minTierForFeature (pricing v2)', () => {
  it('returns "solo" for any feature (no feature gates exist post-v2)', () => {
    expect(minTierForFeature('agent')).toBe('solo')
    expect(minTierForFeature('sage')).toBe('solo')
    expect(minTierForFeature('multi_venue')).toBe('solo')
    expect(minTierForFeature('totally_unknown_feature')).toBe('solo')
  })
})

// ---------------------------------------------------------------------------
// capacityForTier — capacity caps per tier
// ---------------------------------------------------------------------------

describe('capacityForTier', () => {
  it('matches the documented capacity table', () => {
    expect(capacityForTier('pre_opening')).toEqual({
      inquiriesPerMonth: 100,
      venues: 1,
      activeCouplesInPortal: 30,
    })
    expect(capacityForTier('solo')).toEqual({
      inquiriesPerMonth: 150,
      venues: 1,
      activeCouplesInPortal: 50,
    })
    expect(capacityForTier('growth')).toEqual({
      inquiriesPerMonth: 400,
      venues: 1,
      activeCouplesInPortal: 150,
    })
    expect(capacityForTier('multi')).toEqual({
      inquiriesPerMonth: 1200,
      venues: 5,
      activeCouplesInPortal: 400,
    })
  })

  it('returns null caps for enterprise (unlimited)', () => {
    const caps = capacityForTier('enterprise')
    expect(caps.inquiriesPerMonth).toBeNull()
    expect(caps.venues).toBeNull()
    expect(caps.activeCouplesInPortal).toBeNull()
  })

  it('returns the same record exposed via CAPACITY_LIMITS', () => {
    for (const tier of ALL_TIERS) {
      expect(capacityForTier(tier)).toEqual(CAPACITY_LIMITS[tier])
    }
  })
})
