'use client'

/**
 * Venue stats — the top-line counts, from getVenueOverview.
 *
 * The dashboard's quick-stat row counted alerts, an economic index and a
 * queue of recommendations: three real numbers, none of them about the
 * venue's own couples. Anyone opening the dashboard to ask "how many
 * couples do I actually have, and how far back does the data go" had to
 * go somewhere else and got a different answer depending where.
 *
 * This strip answers it once, from the canonical reader, and carries the
 * data-maturity block alongside it — so a count of four booked couples
 * reads as four booked couples out of a spine that only goes back three
 * weeks, rather than as a verdict on the business.
 *
 * The AI briefing, the weather panel and the FRED demand score are
 * untouched. They answer different questions and they have their own
 * sources.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Users } from 'lucide-react'
import { DataMaturity } from '@/components/ui/data-maturity'
import { WhyThisCard } from '@/components/ui/why-this-card'
import type { LifecycleState, VenueOverview } from '@/lib/intel/canonical'

interface ApiResponse {
  ok: boolean
  overview?: VenueOverview
  venueCount?: number
  truncated?: boolean
  error?: string
}

/** Lifecycle states in the order an operator thinks about them, with the
 *  words an operator uses. `agent` is deliberately absent: it is the
 *  bucket for vendors and staff wrongly minted as couples, and it
 *  belongs on the identity-review queue, not on a dashboard. */
const SHOWN: Array<{ key: LifecycleState; label: string; hint: string }> = [
  {
    key: 'channel_scoped',
    label: 'Channel only',
    hint: 'Seen on one channel, not yet resolved to a person.',
  },
  {
    key: 'resolved',
    label: 'Live leads',
    hint: 'Resolved to a real couple, not yet booked.',
  },
  { key: 'booked', label: 'Booked', hint: 'Contract signed.' },
  { key: 'completed', label: 'Completed', hint: 'Wedding has happened.' },
  {
    key: 'ghost',
    label: 'Gone quiet',
    hint: 'Past the full decay window with no new signal.',
  },
]

export function VenueStatsStrip() {
  const [overview, setOverview] = useState<VenueOverview | null>(null)
  const [venueCount, setVenueCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/canonical/overview', { cache: 'no-store' })
      const body = (await res.json()) as ApiResponse
      if (!body.ok || !body.overview) {
        setError(body.error ?? `Overview failed (HTTP ${res.status})`)
      } else {
        setOverview(body.overview)
        setVenueCount(body.venueCount ?? 0)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="h-24 animate-pulse rounded-xl border border-border bg-sage-50"
          />
        ))}
      </div>
    )
  }

  if (error || !overview) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">Could not load venue counts</div>
          <div className="mt-0.5 text-rose-700">{error ?? 'No data returned.'}</div>
        </div>
      </div>
    )
  }

  const { total, byLifecycle } = overview.couples
  const { n, oldestTouchpoint } = overview.dataMaturity

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {SHOWN.map((s) => (
          <div
            key={s.key}
            className="rounded-xl border border-border bg-surface p-5 shadow-sm"
            title={s.hint}
          >
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-sage-400" />
              <span className="text-sm font-medium text-sage-600">{s.label}</span>
            </div>
            <p className="mt-2 text-3xl font-bold tabular-nums text-sage-900">
              {byLifecycle[s.key] ?? 0}
            </p>
            <p className="mt-1 text-xs leading-snug text-sage-500">{s.hint}</p>
          </div>
        ))}
      </div>

      {n === 0 ? (
        <DataMaturity
          current={0}
          threshold={1}
          unit="touchpoints on the spine"
          unlocks="every count above, and every rate on the intelligence pages"
        />
      ) : null}

      <WhyThisCard
        title="What these counts are"
        reasoning="Couples on the identity spine, counted by lifecycle state. Not wedding rows: a couple can be resolved on the spine while its mirrored wedding still says inquiry. A couple that was merged into another is kept in the audit trail but not counted here, so nobody is counted twice."
        evidence={[
          `${total} live couples across ${venueCount === 1 ? 'this venue' : `${venueCount} venues in scope`}.`,
          `${n.toLocaleString()} touchpoints behind those counts.`,
          oldestTouchpoint
            ? `History reaches back to ${new Date(oldestTouchpoint).toLocaleDateString()}.`
            : 'No touchpoint history yet.',
          'Merged-away couples are excluded (merged_into_id is null, migration 379).',
        ]}
        source="getVenueOverview (src/lib/intel/canonical.ts)"
      />

      <p className="text-xs text-sage-500">
        Working a lead?{' '}
        <Link
          href="/agent/leads"
          className="underline underline-offset-2 hover:text-sage-800"
        >
          Today&apos;s list
        </Link>{' '}
        splits these couples into who is waiting on a reply and who is going cold.
      </p>
    </div>
  )
}
