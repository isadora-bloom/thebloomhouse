'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Eye, ArrowRight, ChevronDown } from 'lucide-react'

interface PostTourLead {
  wedding_id: string
  couple_name: string
  tour_date: string | null
  latest_signal_date: string
  platforms: string[]
  signal_count: number
}

function platformLabel(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function fmtDate(d: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function daysAgo(d: string): number {
  return Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000)
}

/**
 * Coordinator-facing card: leads who toured AND are now active
 * on a vendor platform again. Strong signal that they're still
 * considering — perfect timing for a check-in email. Self-hides
 * when there are no such leads.
 *
 * T5-Rixey-GGG Bug 18: list defaults to 6 rows with a "View all N"
 * expand button. Click toggles in-line — no route change so the
 * coordinator's place on the dashboard is preserved.
 *
 * T5-Rixey-GGG Bug 22: rows are post-TOUR, not post-INQUIRY (rewrite
 * lives in src/lib/services/post-tour-browsing.ts). The card no
 * longer shows leads whose latest Knot save is BEFORE their tour
 * date.
 */
const INITIAL_LIMIT = 6

export function PostTourBrowsingCard() {
  const [leads, setLeads] = useState<PostTourLead[]>([])
  const [loading, setLoading] = useState(true)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/intel/post-tour-browsing', { credentials: 'include' })
      .then((r) => r.ok ? r.json() : { leads: [] })
      .then((j) => { if (!cancelled) setLeads(j.leads ?? []) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  if (loading) return null
  if (leads.length === 0) return null

  const visible = showAll ? leads : leads.slice(0, INITIAL_LIMIT)
  const hiddenCount = leads.length - INITIAL_LIMIT

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
          <Eye className="w-4 h-4 text-sage-600" />
          Still browsing after the tour
        </h3>
        <p className="text-xs text-sage-500 mt-1">
          {leads.length} lead{leads.length === 1 ? '' : 's'} returned to a vendor platform after touring.
          They&apos;re still considering — a check-in lands while you&apos;re top-of-mind.
        </p>
      </div>
      <div className="divide-y divide-border max-h-96 overflow-y-auto">
        {visible.map((l) => (
          <Link
            key={l.wedding_id}
            href={`/intel/clients/${l.wedding_id}`}
            className="px-5 py-3 flex items-center gap-3 hover:bg-sage-50/40 transition-colors"
          >
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-sage-900 truncate">
                {l.couple_name}
              </p>
              <p className="text-xs text-sage-500 mt-0.5">
                Toured {fmtDate(l.tour_date)} · last seen on{' '}
                {l.platforms.map(platformLabel).join(' & ')}{' '}
                {fmtDate(l.latest_signal_date)} ({daysAgo(l.latest_signal_date)}d ago) ·{' '}
                {l.signal_count} signal{l.signal_count === 1 ? '' : 's'}
              </p>
            </div>
            <ArrowRight className="w-4 h-4 text-sage-400 shrink-0" />
          </Link>
        ))}
      </div>
      {hiddenCount > 0 && (
        <button
          onClick={() => setShowAll((prev) => !prev)}
          className="w-full px-5 py-2.5 text-xs font-medium text-sage-600 hover:text-sage-900 hover:bg-sage-50/40 transition-colors border-t border-border flex items-center justify-center gap-1"
        >
          {showAll ? (
            <>Show less</>
          ) : (
            <>
              View all {leads.length} <ChevronDown className="w-3 h-3" />
            </>
          )}
        </button>
      )}
    </div>
  )
}
