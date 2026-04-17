'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useVenueId } from './use-venue-id'
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
 */
export function usePlanTier() {
  const venueId = useVenueId()
  const [tier, setTier] = useState<PlanTier>('enterprise') // default until DB responds
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // In demo mode, always show enterprise (full feature set)
    const isDemo = document.cookie.split('; ').some((c) => c === 'bloom_demo=true')
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

    const supabase = createClient()
    supabase
      .from('venues')
      .select('plan_tier')
      .eq('id', venueId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.plan_tier) {
          setTier(data.plan_tier as PlanTier)
        }
        setLoading(false)
      })
  }, [venueId])

  return {
    tier,
    loading,
    hasFeature: (feature: string) => tierHasFeature(tier, feature),
    meetsMinimum: (required: PlanTier) => tierMeetsMinimum(tier, required),
    display: TIER_DISPLAY[tier],
  }
}
