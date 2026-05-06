'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { CheckCircle2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useVenueScope } from '@/lib/contexts/venue-scope-context'

/**
 * SetupProgressPill — sidebar indicator that confirms whether the venue
 * has finished onboarding.
 *
 * Three rendered states:
 *   A. Onboarding incomplete  — amber "Setup incomplete" link to /onboarding
 *   B. Just completed         — emerald "Setup complete" checkmark badge,
 *                               gated on `?onboarding=complete` URL param
 *                               (no `onboarding_completed_at` column exists
 *                               yet so we can't compute a 24h "just" window)
 *   C. Long since complete    — render nothing
 *
 * Reads `venue_config.onboarding_completed` once per (venueId, scope)
 * change and caches in module scope so re-renders / mode switches don't
 * refetch. Demo venues skip the fetch entirely — they're always treated
 * as complete (and migration 048 marks them so anyway).
 *
 * Only renders at venue scope. Group / company scope hides the pill since
 * the status is per-venue.
 */

// Module-level cache. Keyed by venueId so a scope switch picks up the
// new venue's status without a stale read. Cleared by reload, which is
// fine — onboarding completion is a one-way flip during normal usage.
const statusCache = new Map<string, boolean>()

type Status = 'loading' | 'incomplete' | 'complete'

export function SetupProgressPill() {
  const { venueId, level, isDemo } = useVenueScope()
  const searchParams = useSearchParams()
  const justCompleted = searchParams?.get('onboarding') === 'complete'

  const [status, setStatus] = useState<Status>(() => {
    if (isDemo) return 'complete'
    const cached = statusCache.get(venueId)
    if (cached === undefined) return 'loading'
    return cached ? 'complete' : 'incomplete'
  })

  useEffect(() => {
    // Demo venues are always complete; skip the fetch.
    if (isDemo) {
      setStatus('complete')
      return
    }
    // Only check at venue scope. Group/company aggregate views don't
    // surface the per-venue indicator.
    if (level !== 'venue' || !venueId) {
      return
    }

    const cached = statusCache.get(venueId)
    if (cached !== undefined) {
      setStatus(cached ? 'complete' : 'incomplete')
      return
    }

    let cancelled = false
    async function load() {
      const supabase = createClient()
      const { data } = await supabase
        .from('venue_config')
        .select('onboarding_completed')
        .eq('venue_id', venueId)
        .maybeSingle()
      if (cancelled) return
      // Treat missing row as incomplete — onboarding hasn't written
      // venue_config yet.
      const done = Boolean(data?.onboarding_completed)
      statusCache.set(venueId, done)
      setStatus(done ? 'complete' : 'incomplete')
    }
    load()
    return () => {
      cancelled = true
    }
  }, [venueId, level, isDemo])

  // Demo mode — always render nothing. Demo venue is always complete and
  // the demo banner already takes care of orientation.
  if (isDemo) return null

  // Hide outside venue scope. The status is per-venue and doesn't make
  // sense at group / company level.
  if (level !== 'venue') return null

  // Avoid flashing "Setup incomplete" before the fetch resolves.
  if (status === 'loading') return null

  if (status === 'incomplete') {
    return (
      <Link
        href="/onboarding"
        className="block mx-2 mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs"
      >
        <div className="flex items-center justify-between">
          <span className="text-amber-800 font-medium">Setup incomplete</span>
          <span className="text-amber-600">→</span>
        </div>
        <div className="text-amber-700 mt-0.5">Resume onboarding</div>
      </Link>
    )
  }

  // status === 'complete'
  if (justCompleted) {
    return (
      <div className="mx-2 mb-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        <span className="text-emerald-800 font-medium">Setup complete</span>
      </div>
    )
  }

  // State C — long since complete. Nothing to render.
  return null
}
