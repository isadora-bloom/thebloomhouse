'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight } from 'lucide-react'
import type { FreshnessReport } from '@/lib/services/intel/source-freshness'

/**
 * Small banner shown at the top of /intel/sources when one or more
 * tracked sources have crossed their expected cadence. Click-through
 * lands the coordinator on /intel/sources/track where they can act
 * on each one.
 *
 * Self-contained: fetches /api/intel/sources/freshness on mount, no
 * props required (uses caller's auth context). Renders nothing when
 * the venue has no tracked sources, or when every tracked source is
 * fresh.
 */
export function SourceFreshnessBanner() {
  const [reports, setReports] = useState<FreshnessReport[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/intel/sources/freshness')
      .then(async (res) => {
        if (!res.ok) return null
        return (await res.json()) as { reports: FreshnessReport[] }
      })
      .then((json) => {
        if (cancelled || !json) return
        setReports(json.reports ?? [])
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!loaded) return null
  const due = reports.filter((r) => r.reminder_due)
  if (due.length === 0) return null

  const sample = due
    .slice(0, 3)
    .map((r) => r.source_label)
    .join(', ')
  const overflow = due.length > 3 ? ` and ${due.length - 3} more` : ''

  return (
    <Link
      href="/intel/sources/track"
      className="block bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 hover:bg-amber-100/60 transition-colors"
    >
      <div className="flex items-center gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900">
            {due.length} source{due.length === 1 ? '' : 's'} need an upload
          </p>
          <p className="text-xs text-amber-700 mt-0.5 truncate">
            {sample}
            {overflow}. Open Sources to track to drop in fresh data or dismiss.
          </p>
        </div>
        <ArrowRight className="w-4 h-4 text-amber-600 shrink-0" />
      </div>
    </Link>
  )
}
