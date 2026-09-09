'use client'

/**
 * Daily triage rail — the four numbers that decide an operator's morning.
 *
 * Rendered by /agent/leads and /agent/pipeline. Both used to count "hot"
 * and "going cold" for themselves out of weddings + wedding_heat, with
 * their own thresholds, and disagreed. Now both render this, which is fed
 * by /api/intel/canonical/daily-list, which calls getDailyList and
 * getVenueOverview and nothing else.
 *
 * Every bucket carries its rule and where the rule is written down, so
 * "why is this couple going cold" has an answer on the page rather than
 * in someone's head. Every count sits next to the touchpoint `n` behind
 * it, per the honesty doctrine: no aggregate without its sample.
 *
 * Lives under intel/_canonical rather than under either agent route
 * because it belongs to neither — it belongs to the reader. `_canonical`
 * is a private folder, so it is not routable.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AlertCircle, Flame, Loader2, MessageCircle, Snowflake, CalendarClock } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { DataMaturity } from '@/components/ui/data-maturity'
import { WhyThisCard } from '@/components/ui/why-this-card'
import type { DailyList, VenueOverview } from '@/lib/intel/canonical'
import {
  buildTriageRail,
  urgentOverlap,
  type TriageBucketKey,
} from '@/lib/intel/adapters/daily-list-view'

interface ApiResponse {
  ok: boolean
  daily?: DailyList
  overview?: VenueOverview
  /** Latest touchpoint per wedding, keyed by wedding id. Serves the
   *  leads table's "Last Activity" column so it stops deriving the same
   *  fact from `interactions`. */
  lastActivityByWedding?: Record<string, string>
  venueCount?: number
  truncated?: boolean
  error?: string
}

const BUCKET_ICON: Record<TriageBucketKey, LucideIcon> = {
  needsReply: MessageCircle,
  goingCold: Snowflake,
  toursThisWeek: CalendarClock,
  highIntent: Flame,
}

const BUCKET_TONE: Record<TriageBucketKey, string> = {
  needsReply: 'bg-sky-50 text-sky-700',
  goingCold: 'bg-slate-100 text-slate-600',
  toursThisWeek: 'bg-emerald-50 text-emerald-700',
  highIntent: 'bg-orange-50 text-orange-700',
}

export function useCanonicalDaily() {
  const [daily, setDaily] = useState<DailyList | null>(null)
  const [overview, setOverview] = useState<VenueOverview | null>(null)
  const [lastActivityByWedding, setLastActivity] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/canonical/daily-list', { cache: 'no-store' })
      const body = (await res.json()) as ApiResponse
      if (!body.ok || !body.daily || !body.overview) {
        setError(body.error ?? `Daily list failed (HTTP ${res.status})`)
      } else {
        setDaily(body.daily)
        setOverview(body.overview)
        setLastActivity(body.lastActivityByWedding ?? {})
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

  return { daily, overview, lastActivityByWedding, loading, error, reload: load }
}

/**
 * The rail. `activeBucket` lets the host page highlight whichever bucket
 * its own list is currently filtered to, so the rail reads as navigation
 * rather than as a second, competing set of numbers.
 */
export function TriageRail({ activeBucket }: { activeBucket?: TriageBucketKey }) {
  const { daily, overview, loading, error } = useCanonicalDaily()

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-5 text-sm text-sage-600">
        <Loader2 className="h-4 w-4 animate-spin" />
        Reading today&apos;s list from the spine…
      </div>
    )
  }

  if (error || !daily || !overview) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <div className="font-medium">Could not load today&apos;s list</div>
          <div className="mt-0.5 text-rose-700">{error ?? 'No data returned.'}</div>
        </div>
      </div>
    )
  }

  const rail = buildTriageRail(daily, overview)
  const overlap = urgentOverlap(daily)

  if (rail.spineEmpty) {
    return (
      <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
        <p className="text-sm font-medium text-sage-900">
          Nothing on the spine for this venue yet
        </p>
        <p className="text-sm text-sage-600">
          The triage buckets are derived from touchpoints. Until the backfill has
          run there is nothing to count, so the rail shows this rather than four
          confident zeros.
        </p>
        <DataMaturity
          current={0}
          threshold={1}
          unit="touchpoints"
          unlocks="waiting on us, going cold, tours this week and high intent"
        />
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {rail.buckets.map((b) => {
          const Icon = BUCKET_ICON[b.key]
          const active = activeBucket === b.key
          return (
            <div
              key={b.key}
              className={`rounded-xl border bg-surface p-4 shadow-sm transition-colors ${
                active ? 'border-sage-400 ring-1 ring-sage-200' : 'border-border'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`rounded-lg p-1.5 ${BUCKET_TONE[b.key]}`}>
                  <Icon className="h-4 w-4" />
                </span>
                <span className="text-sm font-medium text-sage-700">{b.label}</span>
              </div>
              <p className="mt-2 text-3xl font-bold tabular-nums text-sage-900">
                {b.count}
              </p>
              <p className="mt-1 text-xs leading-snug text-sage-500" title={b.source}>
                {b.count === 0 ? b.emptyCopy : b.rule}
              </p>
              {b.preview.length > 0 ? (
                <ul className="mt-2 space-y-0.5">
                  {b.preview.map((c) => (
                    <li key={c.id} className="truncate text-xs">
                      <Link
                        href={`/intel/couples/${c.id}`}
                        className="text-sage-600 underline-offset-2 hover:text-sage-900 hover:underline"
                      >
                        {c.names ?? '(no name yet)'}
                      </Link>
                    </li>
                  ))}
                  {b.count > b.preview.length ? (
                    <li className="text-xs text-sage-400">
                      +{b.count - b.preview.length} more
                    </li>
                  ) : null}
                </ul>
              ) : null}
            </div>
          )
        })}
      </div>

      {overlap.length > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
          <p className="font-medium text-amber-900">
            {overlap.length} couple{overlap.length === 1 ? ' is' : 's are'} waiting on
            a reply AND going cold
          </p>
          <p className="mt-0.5 text-xs text-amber-800">
            Neither bucket on its own says how urgent this is. Start here:{' '}
            {overlap.slice(0, 4).map((c, i) => (
              <span key={c.id}>
                {i > 0 ? ', ' : ''}
                <Link
                  href={`/intel/couples/${c.id}`}
                  className="underline underline-offset-2"
                >
                  {c.names ?? '(no name yet)'}
                </Link>
              </span>
            ))}
            {overlap.length > 4 ? ` and ${overlap.length - 4} more` : ''}.
          </p>
        </div>
      ) : null}

      <WhyThisCard
        title="How today's list is built"
        reasoning="Every count above comes from getDailyList, the canonical reader. It reads couples, touchpoints and tours on the identity spine and nothing else. The thresholds are not invented for this page: each one is lifted from the migration or the service that already owns it."
        evidence={[
          ...rail.buckets.map((b) => `${b.label}: ${b.rule} (${b.source})`),
          `Counted across ${rail.totalCouples} live couples and ${rail.touchpointCount.toLocaleString()} touchpoints.`,
          rail.oldestTouchpoint
            ? `History goes back to ${new Date(rail.oldestTouchpoint).toLocaleDateString()}.`
            : 'No touchpoint history yet, so treat every count as provisional.',
        ]}
        source="getDailyList + getVenueOverview (src/lib/intel/canonical.ts)"
      />
    </div>
  )
}

/**
 * Lifecycle counts from getVenueOverview. Small enough to sit under the
 * rail on a pipeline board, where the kanban columns count wedding
 * statuses and this counts couple lifecycle states — two different
 * questions, which the caption says out loud so they are not mistaken
 * for two answers to one.
 */
export function LifecycleStrip() {
  const { overview, loading, error } = useCanonicalDaily()
  if (loading || error || !overview) return null

  const entries = Object.entries(overview.couples.byLifecycle).filter(
    ([, n]) => n > 0,
  )
  if (entries.length === 0) return null

  return (
    <div className="rounded-xl border border-border bg-warm-white px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <span className="text-xs uppercase tracking-wide text-sage-500">
          Couples on the spine
        </span>
        <span className="text-sm font-medium text-sage-900">
          {overview.couples.total}
        </span>
        {entries.map(([state, n]) => (
          <span key={state} className="text-xs text-sage-600">
            {state.replace(/_/g, ' ')} {n}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[11px] text-sage-500">
        Lifecycle state on the identity spine, not the wedding status the board
        columns use. A couple can be resolved on the spine while its wedding row
        still says inquiry.
      </p>
    </div>
  )
}
