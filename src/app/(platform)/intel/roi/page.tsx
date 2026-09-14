'use client'

/**
 * /intel/roi — "Your Impact".
 *
 * W64: this page used to run eight browser queries of its own across
 * `interactions`, `weddings`, `drafts` and `draft_feedback`, and derive
 * every figure inline. That gave it its own idea of an inquiry, its own
 * idea of a first response, and its own idea of a booking, none of which
 * matched /intel/cohort, /intel/sources or Ask your data.
 *
 * It now holds no queries. One fetch to /api/intel/canonical/impact
 * returns what the readers already know, and the channel table at the
 * bottom is `ChannelTruthSection` — the same component /intel/sources
 * renders, hitting the same endpoint, calling the same
 * `getSourceAttribution`. The two pages cannot disagree about a channel,
 * because there is only one function.
 *
 * Three figures changed on purpose, and the page says so on screen:
 *   - first response is a MEDIAN in hours from `getCohortFunnel`, not a
 *     mean in minutes this page invented;
 *   - "leads rescued" became the funnel's drop-off point, which is the
 *     measured version of the same claim rather than a threshold someone
 *     picked;
 *   - pipeline is a count of live couples, not a sum of quoted values.
 *     `couples` carries no revenue column, and the old sum read as
 *     money the venue had never been promised.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Mail,
  Clock,
  Timer,
  TrendingDown,
  TrendingUp,
  ThumbsUp,
  ArrowUp,
  ArrowDown,
  Minus,
  BarChart3,
  Loader2,
  AlertCircle,
} from 'lucide-react'
import { WhyThisCard } from '@/components/ui/why-this-card'
import { renderDistribution, WITHHELD } from '@/lib/intel/adapters/honesty'
import type { Distribution, CohortFunnel } from '@/lib/intel/canonical'
import { ChannelTruthSection } from '../_canonical/channel-truth'

// ---------------------------------------------------------------------------
// Wire types — mirror /api/intel/canonical/impact
// ---------------------------------------------------------------------------

interface ImpactPart {
  venueId: string
  venueName: string | null
  responseTime: Distribution
  knee: CohortFunnel['knee']
}

interface ImpactTotals {
  inquiries: { thisMonth: number; lastMonth: number }
  bookings: { thisMonth: number; lastMonth: number }
  livePipelineCouples: number
  unstampedThisMonth: number
  draftsThisMonth: number
  draftsLastMonth: number
  feedbackTotal: number
  feedbackApproved: number
}

interface ApiResponse {
  ok: boolean
  venueCount?: number
  truncated?: boolean
  totals?: ImpactTotals
  parts?: ImpactPart[]
  error?: string
}

const EMPTY_TOTALS: ImpactTotals = {
  inquiries: { thisMonth: 0, lastMonth: 0 },
  bookings: { thisMonth: 0, lastMonth: 0 },
  livePipelineCouples: 0,
  unstampedThisMonth: 0,
  draftsThisMonth: 0,
  draftsLastMonth: 0,
  feedbackTotal: 0,
  feedbackApproved: 0,
}

// Time we assume a coordinator spends typing one response from scratch.
// An internal model assumption, not an industry benchmark, and the label
// on screen says which.
const ESTIMATED_MINUTES_PER_DRAFT = 8

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trendIndicator(current: number, previous: number) {
  if (previous === 0 && current === 0) return { direction: 'flat' as const, pct: 0 }
  if (previous === 0) return { direction: 'up' as const, pct: 100 }
  const pct = Math.round(((current - previous) / previous) * 100)
  if (pct > 0) return { direction: 'up' as const, pct }
  if (pct < 0) return { direction: 'down' as const, pct: Math.abs(pct) }
  return { direction: 'flat' as const, pct: 0 }
}

function TrendBadge({ direction, label }: { direction: 'up' | 'down' | 'flat'; label: string }) {
  if (direction === 'up') {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-emerald-600">
        <ArrowUp className="w-3 h-3" />
        {label}
      </span>
    )
  }
  if (direction === 'down') {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs font-medium text-red-500">
        <ArrowDown className="w-3 h-3" />
        {label}
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-xs font-medium text-sage-400">
      <Minus className="w-3 h-3" />
      {label}
    </span>
  )
}

function EmptyNote({ text }: { text: string }) {
  return <p className="text-[10px] text-sage-400 mt-1 leading-tight">{text}</p>
}

/** Median hours, as a sentence an operator reads rather than a decimal. */
function hoursText(d: Distribution): string {
  const rendered = renderDistribution(d, 'number')
  if (rendered.text === WITHHELD || d.value === null) return '--'
  const hours = d.value
  if (hours < 1) return `${Math.round(hours * 60)}m`
  if (hours < 48) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ROIDashboardPage() {
  const [totals, setTotals] = useState<ImpactTotals>(EMPTY_TOTALS)
  const [parts, setParts] = useState<ImpactPart[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/canonical/impact', { cache: 'no-store' })
      const body = (await res.json()) as ApiResponse
      if (!body.ok) {
        setError(body.error ?? `Impact failed (HTTP ${res.status})`)
        setTotals(EMPTY_TOTALS)
        setParts([])
        return
      }
      setTotals(body.totals ?? EMPTY_TOTALS)
      setParts(body.parts ?? [])
      setTruncated(Boolean(body.truncated))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const inquiryTrend = trendIndicator(totals.inquiries.thisMonth, totals.inquiries.lastMonth)
  const bookingTrend = trendIndicator(totals.bookings.thisMonth, totals.bookings.lastMonth)

  const hoursSaved =
    Math.round((totals.draftsThisMonth * ESTIMATED_MINUTES_PER_DRAFT) / 60 * 10) / 10
  const hoursSavedLastMonth =
    Math.round((totals.draftsLastMonth * ESTIMATED_MINUTES_PER_DRAFT) / 60 * 10) / 10
  const hoursTrend = trendIndicator(hoursSaved, hoursSavedLastMonth)

  const aiAccuracy =
    totals.feedbackTotal > 0
      ? Math.round((totals.feedbackApproved / totals.feedbackTotal) * 100)
      : null

  // Response time is a median, and medians do not add. With one venue in
  // scope there is one median to print; with several, the card says to
  // read the per-venue rows below rather than inventing a blended figure.
  const singleVenue = parts.length === 1 ? parts[0] : null
  const knee = singleVenue?.knee ?? null

  const cards = [
    {
      label: 'Inquiries Handled',
      value: totals.inquiries.thisMonth,
      icon: Mail,
      color: 'text-sage-600',
      bg: 'bg-sage-50',
      trend: <TrendBadge direction={inquiryTrend.direction} label={`${inquiryTrend.pct}% vs last month`} />,
      note:
        totals.unstampedThisMonth > 0 ? (
          <EmptyNote
            text={`${totals.unstampedThisMonth} touchpoint${totals.unstampedThisMonth === 1 ? '' : 's'} this month carry no direction stamp and are not counted either way.`}
          />
        ) : null,
    },
    {
      label: 'Median First Response',
      value: singleVenue ? hoursText(singleVenue.responseTime) : parts.length > 1 ? 'per venue' : '--',
      icon: Clock,
      color: 'text-teal-600',
      bg: 'bg-teal-50',
      trend: singleVenue && singleVenue.responseTime.value !== null ? (
        <span className="text-xs text-sage-500">n={singleVenue.responseTime.n} couples</span>
      ) : null,
      note:
        singleVenue && singleVenue.responseTime.value === null ? (
          <EmptyNote text="Needs a couple with an inbound touch and a reply after it." />
        ) : parts.length > 1 ? (
          <EmptyNote text="Medians do not add. One row per venue below." />
        ) : null,
    },
    {
      label: 'Hours Saved',
      value: hoursSaved > 0 ? `~${hoursSaved}h` : '--',
      icon: Timer,
      color: 'text-emerald-600',
      bg: 'bg-emerald-50',
      trend: hoursSaved > 0 ? (
        <TrendBadge direction={hoursTrend.direction} label={`${hoursTrend.pct}% vs last month`} />
      ) : null,
      note:
        hoursSaved === 0 ? (
          <EmptyNote text="Based on AI drafts generated (8 min saved per draft)." />
        ) : null,
    },
    {
      label: 'Replying Late Costs',
      value: knee ? `${Math.round(knee.dropoffAfter * 100)}pts` : '--',
      icon: TrendingDown,
      color: 'text-orange-600',
      bg: 'bg-orange-50',
      trend: knee ? (
        <span className="text-xs text-orange-600 font-medium">
          tour rate falls after {Math.round(knee.responseHours)}h
        </span>
      ) : null,
      note: knee ? null : (
        <EmptyNote text="No drop-off point detectable yet. Needs couples across several response-speed bands." />
      ),
    },
    {
      label: 'Bookings This Month',
      value: totals.bookings.thisMonth > 0 ? totals.bookings.thisMonth : '--',
      icon: TrendingUp,
      color: 'text-purple-600',
      bg: 'bg-purple-50',
      trend:
        totals.bookings.thisMonth > 0 ? (
          <TrendBadge direction={bookingTrend.direction} label={`${bookingTrend.pct}% vs last month`} />
        ) : (
          <span className="text-xs text-sage-400">
            {totals.livePipelineCouples > 0
              ? `${totals.livePipelineCouples} live couples in the pipeline`
              : 'No live couples yet'}
          </span>
        ),
      note: null,
    },
    {
      label: 'AI Draft Accuracy',
      value: aiAccuracy !== null ? `${aiAccuracy}%` : '--',
      icon: ThumbsUp,
      color: 'text-blue-600',
      bg: 'bg-blue-50',
      trend:
        aiAccuracy !== null ? (
          <span className="text-xs text-blue-600 font-medium">
            approved as-is ({totals.feedbackTotal} reviews)
          </span>
        ) : null,
      note:
        aiAccuracy === null ? (
          <EmptyNote text="Start approving drafts to see this metric." />
        ) : null,
    },
  ]

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 bg-emerald-50 rounded-xl">
          <BarChart3 className="w-6 h-6 text-emerald-600" />
        </div>
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900">Your Impact</h1>
          <p className="text-sage-600 mt-0.5">
            What Bloom House changed about your venue operations this month.
          </p>
        </div>
      </div>

      {error ? (
        <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Could not load your impact</div>
            <div className="mt-0.5 text-rose-700">{error}</div>
          </div>
        </div>
      ) : null}

      {/* Stat Cards - 2x3 grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
        {cards.map((card) => (
          <div
            key={card.label}
            className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow"
          >
            <div className="flex items-start gap-3 mb-3">
              <div className={`${card.bg} p-2.5 rounded-lg shrink-0`}>
                <card.icon className={`w-5 h-5 ${card.color}`} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-sage-500 uppercase tracking-wider">
                  {card.label}
                </p>
              </div>
            </div>

            <div className="pl-0">
              {loading ? (
                <div className="h-9 w-20 bg-sage-100 rounded-lg animate-pulse" />
              ) : (
                <p className="text-3xl font-bold text-sage-900 tabular-nums">{card.value}</p>
              )}
            </div>

            {!loading && (
              <div className="mt-2 min-h-[20px]">
                {card.trend}
                {card.note}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Per-venue response time, when the scope covers more than one. */}
      {!loading && parts.length > 1 ? (
        <div className="bg-surface border border-border rounded-xl p-6 shadow-sm">
          <h2 className="font-heading text-lg font-semibold text-sage-900 mb-3">
            Median first response, by venue
          </h2>
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase tracking-wide text-sage-500">
              <tr>
                <th className="py-2">Venue</th>
                <th className="py-2 text-right">Median reply</th>
                <th className="py-2 text-right">Couples</th>
              </tr>
            </thead>
            <tbody>
              {parts.map((p) => (
                <tr key={p.venueId} className="border-t border-border first:border-t-0">
                  <td className="py-2 text-sage-900">{p.venueName ?? p.venueId}</td>
                  <td className="py-2 text-right tabular-nums text-sage-900">
                    {hoursText(p.responseTime)}
                  </td>
                  <td className="py-2 text-right tabular-nums text-sage-500">
                    {p.responseTime.n}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {truncated ? (
            <p className="mt-3 text-xs text-sage-500">
              Showing the first {parts.length} venues in this scope.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Channel truth — the same component and endpoint /intel/sources renders. */}
      <div className="bg-surface border border-border rounded-xl p-6 shadow-sm space-y-4">
        <div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            Which channels are working
          </h2>
          <p className="text-sm text-sage-600 mt-0.5">
            The same table as Sources, from the same reader. If the two pages ever
            disagree it is a bug, not a difference of opinion.
          </p>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-sage-600">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : (
          <ChannelTruthSection model="first_touch" />
        )}
      </div>

      {/* Context section */}
      <WhyThisCard
        title="How these numbers are worked out"
        reasoning="Every figure on this page is returned by a reader, not computed here. The page holds no database queries at all, so it cannot drift away from the rest of the platform."
        evidence={[
          'Inquiries Handled counts inbound touchpoints this calendar month. Direction is stamped when the touchpoint is written and never guessed at afterwards, so an unstamped row is reported rather than counted.',
          'Median First Response is getCohortFunnel().responseTime — the median hours between a couple reaching out and the venue replying, over couples with both. A median, not a mean, and never blended across venues.',
          `Hours Saved assumes ${ESTIMATED_MINUTES_PER_DRAFT} minutes per response written from scratch, multiplied by AI drafts generated. A model estimate, not an industry benchmark.`,
          'Replying Late Costs is the funnel’s drop-off point: the response-speed band after which the tour rate falls most, and by how many points. It replaces the old "leads rescued" card, which counted replies under an hour against a threshold nobody had measured.',
          'Bookings This Month counts couples with a contract-signed touchpoint this month, once each however many contract events they have.',
          'Pipeline is a count of live couples. The spine carries no revenue column, so there is no pipeline value to show, and a sum of quoted figures would have been money nobody promised you.',
        ]}
        source="getCohortFunnel + getVenueOverview + loadVenueImpact (src/lib/intel)"
      />
    </div>
  )
}
