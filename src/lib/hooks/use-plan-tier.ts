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
 *
 * Phase 1 audit fixes:
 * - Default tier is now 'starter' (not 'enterprise') so gates don't flash
 *   open while loading — guards should fail closed.
 * - Supabase realtime subscription on the venues row means a Stripe webhook
 *   upgrade propagates to the sidebar without a page reload.
 * - Window focus listener refetches when the coordinator returns from the
 *   Stripe payment page in another tab.
 */
export function usePlanTier() {
  const { venueId, isDemo } = useVenueScope()
  // Default to 'starter' so feature gates fail closed during the initial
  // fetch instead of momentarily showing paid-tier content.
  const [tier, setTier] = useState<PlanTier>('starter')
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

    function fetchTier() {
      if (cancelled) return
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
    }

    fetchTier()

    // Realtime: when the Stripe webhook lands and updates venues.plan_tier
    // the sidebar reflects the new tier immediately without a page reload.
    const channel = supabase
      .channel(`venue-plan:${venueId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'venues',
          filter: `id=eq.${venueId}`,
        },
        () => {
          fetchTier()
        },
      )
      .subscribe()

    // Focus listener: coordinator was on the Stripe payment page in another
    // tab — re-check the tier when they switch back.
    function onFocus() {
      fetchTier()
    }
    window.addEventListener('focus', onFocus)

    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      supabase.removeChannel(channel)
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
