'use client'

/**
 * HoneybookStaleBanner — nudges coordinators to re-export HoneyBook when
 * their last import is going stale.
 *
 * HoneyBook integration is CSV-only (no API). The PostOnboardingChecklist
 * already prompts a venue to do their FIRST import (it shows the row only
 * when count of crm_source='honeybook' weddings is zero). But after that
 * first import, nothing reminds them that HoneyBook keeps accumulating new
 * bookings — so a 30+ day stale import means Bloom is missing roughly a
 * month of CRM data and Sage's context drifts.
 *
 * Visibility rules (mutually exclusive with the checklist by construction):
 *   - Only renders at venue scope (per-venue check doesn't make sense
 *     across a portfolio).
 *   - Hidden in demo mode (Crestwood seed, fake data).
 *   - Renders ONLY when at least one wedding row has crm_source='honeybook'
 *     AND the most recent such row's created_at is >= 30 days old.
 *   - Hidden if dismissed within the last 7 days for this venue
 *     (localStorage key `bloom_honeybook_stale_dismissed_<venueId>`).
 *
 * Staleness signal — schema-grounded:
 *   The `weddings` table (migration 001) has `created_at` and `updated_at`
 *   but NO `last_synced_at` and there is no dedicated import-tracking
 *   table. We pick MAX(created_at) over MAX(updated_at) deliberately:
 *   `updated_at` ticks on any downstream edit (status changes, heat-score
 *   recompute, coordinator notes) and would overstate import freshness.
 *   `created_at` only moves when a new HoneyBook row is inserted, which
 *   is exactly the signal we want — "no new HoneyBook bookings have shown
 *   up in 30+ days."
 *
 * Re-import link points at `/onboarding/crm-import` — the existing CSV
 * upload route the checklist also uses.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { useScope } from '@/lib/hooks/use-scope'
import { X, AlertCircle } from 'lucide-react'
import { useVenueScope } from '@/lib/contexts/venue-scope-context'

const DISMISS_KEY_PREFIX = 'bloom_honeybook_stale_dismissed_'
const DISMISS_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const STALE_THRESHOLD_DAYS = 30
const MS_PER_DAY = 86_400_000

interface State {
  show: boolean
  daysSinceImport: number | null
}

export function HoneybookStaleBanner() {
  const scope = useScope()
  // useScope() doesn't expose `isDemo` (the legacy adapter strips it), so
  // read the underlying provider directly for the demo guard.
  const venueScope = useVenueScope()
  const [state, setState] = useState<State>({ show: false, daysSinceImport: null })

  useEffect(() => {
    let cancelled = false

    if (scope.level !== 'venue' || !scope.venueId) return
    if (venueScope.isDemo) return

    // Dismissal check — fresh-mounted banner respects the 7-day TTL.
    const dismissKey = DISMISS_KEY_PREFIX + scope.venueId
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(dismissKey)
        if (raw) {
          const dismissedAt = Number(raw)
          if (Number.isFinite(dismissedAt) && Date.now() - dismissedAt < DISMISS_TTL_MS) {
            return
          }
        }
      } catch {
        // localStorage disabled — fall through and just show the banner.
      }
    }

    const supabase = createClient()

    // Most recent HoneyBook-sourced wedding (by created_at). If there are
    // zero, this resolves with no row and we render nothing — the
    // PostOnboardingChecklist owns the "you haven't imported yet" prompt.
    supabase
      .from('weddings')
      .select('created_at')
      .eq('venue_id', scope.venueId)
      .eq('crm_source', 'honeybook')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return
        if (error || !data?.created_at) return

        const importedAt = new Date(data.created_at).getTime()
        if (!Number.isFinite(importedAt)) return

        const daysSince = Math.floor((Date.now() - importedAt) / MS_PER_DAY)
        if (daysSince >= STALE_THRESHOLD_DAYS) {
          setState({ show: true, daysSinceImport: daysSince })
        }
      })

    return () => {
      cancelled = true
    }
  }, [scope.venueId, scope.level, venueScope.isDemo])

  function dismiss() {
    if (scope.venueId && typeof window !== 'undefined') {
      try {
        window.localStorage.setItem(DISMISS_KEY_PREFIX + scope.venueId, String(Date.now()))
      } catch {
        // localStorage disabled — just hide for this session.
      }
    }
    setState({ show: false, daysSinceImport: null })
  }

  if (!state.show || state.daysSinceImport === null) return null

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 mb-4 flex items-start gap-3">
      <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" aria-hidden />
      <div className="flex-1 min-w-0">
        <p className="text-sm text-amber-900">
          Your HoneyBook import is{' '}
          <strong>{state.daysSinceImport} days old</strong>. Re-export from
          HoneyBook and upload to keep Sage in sync.
        </p>
        <Link
          href="/onboarding/crm-import"
          className="inline-flex items-center text-sm text-amber-700 hover:text-amber-900 mt-1 underline"
        >
          Re-import HoneyBook data →
        </Link>
      </div>
      <button
        type="button"
        onClick={dismiss}
        className="text-amber-600 hover:text-amber-900 shrink-0"
        aria-label="Dismiss"
        title="Hide for 7 days"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
