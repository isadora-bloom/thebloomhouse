// ---------------------------------------------------------------------------
// Plan tier constants + pure functions.
//
// This module is intentionally free of 'use client' so both server (route
// handlers, middleware, requirePlan) and client (usePlanTier hook, gate
// components) can import it safely. See BUG-08A: previously lived in
// src/lib/hooks/use-plan-tier.ts, which is marked 'use client' and broke
// every server-side requirePlan() call.
// ---------------------------------------------------------------------------

export type PlanTier = 'starter' | 'intelligence' | 'enterprise'

// Feature access per tier
const TIER_FEATURES: Record<PlanTier, Set<string>> = {
  starter: new Set([
    'agent', 'inbox', 'drafts', 'pipeline', 'leads', 'sequences',
    'analytics', 'knowledge_gaps', 'relationships', 'codes',
    'learning', 'rules', 'personality', 'voice',
    'portal', 'weddings', 'messages', 'sage_queue', 'kb', 'vendors',
    'venue_config', 'settings', 'onboarding',
    'basic_dashboard',
  ]),
  intelligence: new Set([
    // Everything in starter +
    'dashboard', 'market_pulse', 'nlq', 'briefings', 'sources',
    'trends', 'reviews', 'tours', 'lost_deals', 'campaigns',
    'social', 'capacity', 'forecasts', 'health',
    'couple_portal', 'sage',
  ]),
  enterprise: new Set([
    // Everything in intelligence +
    'portfolio', 'company', 'cross_venue', 'team',
    'regions', 'all_clients', 'deduplication',
    'multi_venue', 'venue_groups',
  ]),
}

// Tier hierarchy: enterprise > intelligence > starter
export const TIER_RANK: Record<PlanTier, number> = {
  starter: 0,
  intelligence: 1,
  enterprise: 2,
}

/**
 * Check if a given tier has access to a specific feature.
 * Access is cumulative: enterprise has everything intelligence has, etc.
 */
export function tierHasFeature(tier: PlanTier, feature: string): boolean {
  for (const [t, features] of Object.entries(TIER_FEATURES)) {
    if (TIER_RANK[t as PlanTier] <= TIER_RANK[tier] && features.has(feature)) {
      return true
    }
  }
  return false
}

/**
 * Get the minimum tier required for a feature.
 */
export function minTierForFeature(feature: string): PlanTier {
  if (TIER_FEATURES.starter.has(feature)) return 'starter'
  if (TIER_FEATURES.intelligence.has(feature)) return 'intelligence'
  return 'enterprise'
}

/**
 * Check if `current` meets or exceeds the level of `required`.
 */
export function tierMeetsMinimum(current: PlanTier, required: PlanTier): boolean {
  return TIER_RANK[current] >= TIER_RANK[required]
}

// Map marketing names to internal names for display
export const TIER_DISPLAY: Record<PlanTier, { name: string; price: string }> = {
  starter: { name: 'Starter', price: '$199/mo' },
  intelligence: { name: 'Growth', price: '$399/mo' },
  enterprise: { name: 'Portfolio', price: 'Custom' },
}
