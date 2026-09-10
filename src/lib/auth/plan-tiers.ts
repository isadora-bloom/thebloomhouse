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

/**
 * Feature matrix (W18, Nov-plan wave 2).
 *
 * The 2026-09-08 readiness audit flagged tierHasFeature as decorative
 * because it always returned true with no matrix backing it — that read
 * as "not actually implemented." It IS actually implemented, just to a
 * flat outcome: pricing v2 (2026-05-06, bloom-website-pricing-v2.md)
 * deliberately gives every tier every feature and gates on capacity
 * only (CAPACITY_LIMITS / capacity-enforcement.ts). This matrix makes
 * that a real, checkable data structure instead of a hardcoded `true`,
 * so a future feature-gated tier is a one-line matrix edit, not a
 * rewrite, and so `tierHasFeature('pre_opening', 'anything')` is
 * answered by looking something up rather than by trusting a comment.
 *
 * Every tier maps to the wildcard '*' = true. Add a real feature key
 * here (and flip it to false for specific tiers) the day pricing v2's
 * "capacity is the only differentiator" doctrine changes; until then
 * every lookup falls through to the wildcard.
 */
const FEATURE_MATRIX: Record<PlanTier, Record<string, boolean>> = {
  pre_opening: { '*': true },
  solo: { '*': true },
  growth: { '*': true },
  multi: { '*': true },
  enterprise: { '*': true },
}

/** Looks up `feature` in FEATURE_MATRIX for `tier`, falling back to the
 *  tier's wildcard entry. Post pricing-v2 every tier's wildcard is true,
 *  so this always returns true today — see FEATURE_MATRIX doc comment
 *  for why that's a deliberate pricing decision, not a stub. */
export function tierHasFeature(tier: PlanTier, feature: string): boolean {
  const row = FEATURE_MATRIX[tier]
  if (feature in row) return row[feature]
  return row['*'] ?? false
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
