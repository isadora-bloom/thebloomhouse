// ---------------------------------------------------------------------------
// Plan tier constants + pure functions.
//
// Pricing v2 (2026-05-06): 5-tier capacity-gated model. Every tier gets every
// feature. Capacity is the only differentiator. See bloom-website-pricing-v2.md
// for the strategic context.
//
// This module is intentionally free of 'use client' so both server (route
// handlers, middleware, requirePlan) and client (usePlanTier hook, gate
// components) can import it safely.
// ---------------------------------------------------------------------------

export type PlanTier = 'pre_opening' | 'solo' | 'growth' | 'multi' | 'enterprise'

export interface CapacityLimits {
  inquiriesPerMonth: number | null  // null = unlimited (enterprise)
  venues: number | null
  activeCouplesInPortal: number | null
}

export const CAPACITY_LIMITS: Record<PlanTier, CapacityLimits> = {
  pre_opening: { inquiriesPerMonth: 100, venues: 1, activeCouplesInPortal: 30 },
  solo: { inquiriesPerMonth: 150, venues: 1, activeCouplesInPortal: 50 },
  growth: { inquiriesPerMonth: 400, venues: 1, activeCouplesInPortal: 150 },
  multi: { inquiriesPerMonth: 1200, venues: 5, activeCouplesInPortal: 400 },
  enterprise: { inquiriesPerMonth: null, venues: null, activeCouplesInPortal: null },
}

export const TIER_RANK: Record<PlanTier, number> = {
  pre_opening: 0,
  solo: 1,
  growth: 2,
  multi: 3,
  enterprise: 4,
}

export const TIER_DISPLAY: Record<PlanTier, { name: string; price: string; tagline: string }> = {
  pre_opening: { name: 'Pre-Opening', price: '$99/mo', tagline: 'For venues not yet open' },
  solo:        { name: 'Solo',        price: '$299/mo', tagline: 'For established single venues' },
  growth:      { name: 'Growth',      price: '$549/mo', tagline: 'For venues with staff' },
  multi:       { name: 'Multi',       price: '$1,099/mo', tagline: 'For small portfolios' },
  enterprise:  { name: 'Enterprise',  price: 'Custom', tagline: 'For venue groups (6+)' },
}

/** Every tier has every feature. Kept for backward compat with callers; always returns true. */
export function tierHasFeature(_tier: PlanTier, _feature: string): boolean {
  return true
}

/** No feature gates exist post-v2. Returns the lowest paid tier for any feature. */
export function minTierForFeature(_feature: string): PlanTier {
  return 'solo'
}

/** True if `current` is at or above `required` in the tier ladder. */
export function tierMeetsMinimum(current: PlanTier, required: PlanTier): boolean {
  return TIER_RANK[current] >= TIER_RANK[required]
}

export function capacityForTier(tier: PlanTier): CapacityLimits {
  return CAPACITY_LIMITS[tier]
}
