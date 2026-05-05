'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueScope } from '@/lib/contexts/venue-scope-context'
import {
  tierHasFeature,
  tierMeetsMinimum,
  minTierForFeature,
  TIER_DISPLAY,
  type PlanTier,
} from '@/lib/auth/plan-tiers'

// Re-export the pure helpers so existing imports of
// '@/lib/hooks/use-plan-tier' keep working. The canonical source of truth
// for tier logic lives in '@/lib/auth/plan-tiers' (server-safe).
export {
  tierHasFeature,
  tierMeetsMinimum,
  minTierForFeature,
  TIER_DISPLAY,
  type PlanTier,
}

/**
 * Reads the current venue's plan_tier from the database.
 * Returns tier + loading state + utility functions.
 *
 * `venueId` and `isDemo` come from `VenueScopeProvider` (server-resolved
 * + client-mutable), so a scope switch via `useScopeMutator()` triggers
 * an immediate re-fetch of plan_tier without a full page reload.
 */
export function usePlanTier() {
  const { venueId, isDemo } = useVenueScope()
  const [tier, setTier] = useState<PlanTier>('enterprise') // default until DB responds
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // In demo mode, always show enterprise (full feature set)
    if (isDemo) {
      setTier('enterprise')
      setLoading(false)
      return
    }

    // No venue yet (scope still resolving) — skip the query
    if (!venueId) {
      setLoading(false)
      return
    }

    let cancelled = false
    setLoading(true)
    const supabase = createClient()
    supabase
      .from('venues')
      .select('plan_tier')
      .eq('id', venueId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return
        if (data?.plan_tier) {
          setTier(data.plan_tier as PlanTier)
        }
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [venueId, isDemo])

  return {
    tier,
    loading,
    hasFeature: (feature: string) => tierHasFeature(tier, feature),
    meetsMinimum: (required: PlanTier) => tierMeetsMinimum(tier, required),
    display: TIER_DISPLAY[tier],
  }
}
