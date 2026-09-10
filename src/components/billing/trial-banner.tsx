'use client'

import { useEffect, useState } from 'react'
import { useAiName } from '@/lib/hooks/use-ai-name'
import { AlertTriangle } from 'lucide-react'
import Link from 'next/link'

/**
 * W18 (Nov-plan wave 2) — "a venue past trial_ends_at with no subscription
 * sees a banner on every platform page". Split into a hook (so the layout
 * shell can know whether the banner is showing, for its top-offset math —
 * the same reason DemoBanner's isDemo flag comes from context rather than
 * the banner fetching it privately) and a presentational component.
 *
 * Skips the fetch entirely in demo mode — a demo venue is never on a real
 * trial and requirePlan/usePlanTier already special-case demo the same
 * way.
 */
export function useTrialExpired(isDemo: boolean): boolean {
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    if (isDemo) {
      setExpired(false)
      return
    }
    let cancelled = false
    fetch('/api/billing/trial-status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled && data?.trialExpired) setExpired(true)
      })
      .catch(() => {
        // Never block page render on a failed banner check.
      })
    return () => {
      cancelled = true
    }
  }, [isDemo])

  return expired
}

/**
 * Fixed banner at the very top of the page. Same fixed/h-10/z-60 shape as
 * DemoBanner so PlatformShell can treat the two as mutually exclusive top
 * banners and reuse the same layout-offset classes — a venue is never
 * both demo and a real expired trial at once, so there's no stacking case
 * to handle.
 *
 * Deliberately informational only. Nothing else on the platform is
 * blocked by trial expiry (see billing-state.ts) except auto-send, which
 * is enforced separately in the dispatch path (autonomous-sender.ts) —
 * this banner does not itself gate anything.
 */
export function TrialExpiredBanner() {
  const aiName = useAiName()
  return (
    <div className="fixed top-0 left-0 right-0 z-[60] h-10 bg-amber-50 border-b border-amber-200 px-4 flex items-center justify-between gap-3 text-sm">
      <div className="flex items-center gap-2 text-amber-800">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="font-medium">Your trial has ended</span>
        <span className="hidden sm:inline text-amber-600">
          {aiName} still runs, but auto-send is paused. Subscribe to turn it back on.
        </span>
      </div>
      <Link
        href="/settings/billing"
        className="inline-flex items-center px-3 py-1 bg-amber-600 text-white rounded-md text-xs font-medium hover:bg-amber-700 transition-colors"
      >
        View billing
      </Link>
    </div>
  )
}
