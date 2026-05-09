'use client'

/**
 * Solo pill — surfaces `weddings.partner_count = 1` on inbox + leads
 * rows. Wave 2D (2026-05-09).
 *
 * The pill signals to the coordinator that the system intentionally
 * classified the wedding as a single decision-maker (vs a missing
 * partner2 data gap). Sage prompts use a singular salutation when the
 * flag is set.
 *
 * Defensive — only renders on a positive 1. NULL / 2 / unknown stays
 * silent. Works on either side of the mig-255 deploy boundary; the
 * batch endpoint returns all-NULL when the column isn't there yet.
 */

import { useEffect, useRef, useState } from 'react'
import { User } from 'lucide-react'
import { cn } from '@/lib/utils'

interface UseBatchOptions {
  venueId?: string | null
}

export function useBatchPartnerCounts(
  weddingIds: Array<string | null | undefined>,
  options: UseBatchOptions = {},
): Record<string, 1 | null> {
  const cleanIds = Array.from(
    new Set(
      (weddingIds ?? []).filter(
        (v): v is string => typeof v === 'string' && v.length > 0,
      ),
    ),
  ).sort()
  const key = cleanIds.join(',')
  const [counts, setCounts] = useState<Record<string, 1 | null>>({})
  const inFlight = useRef<string | null>(null)

  useEffect(() => {
    if (cleanIds.length === 0) {
      setCounts({})
      return
    }
    if (inFlight.current === key) return
    inFlight.current = key

    let cancelled = false
    ;(async () => {
      try {
        const url = options.venueId
          ? `/api/intel/partner-counts/batch?venueId=${encodeURIComponent(options.venueId)}`
          : '/api/intel/partner-counts/batch'
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ weddingIds: cleanIds }),
        })
        if (!res.ok) {
          if (!cancelled) setCounts({})
          return
        }
        const json = (await res.json()) as { counts?: Record<string, 1 | null> }
        if (!cancelled) setCounts(json.counts ?? {})
      } catch {
        if (!cancelled) setCounts({})
      }
    })()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, options.venueId])

  return counts
}

export function SoloPill({
  partnerCount,
  className,
}: {
  partnerCount: 1 | null | undefined
  className?: string
}) {
  if (partnerCount !== 1) return null
  return (
    <span
      title="Single decision-maker. Phantom-partner detector flagged this couple as a 1-partner wedding."
      className={cn(
        'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium',
        'bg-sage-50 text-sage-700 border border-sage-200',
        className,
      )}
    >
      <User className="w-2.5 h-2.5" />
      <span>Solo</span>
    </span>
  )
}
