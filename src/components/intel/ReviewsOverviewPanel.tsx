'use client'

/**
 * Reviews overview dashboard panel (TIER 7b, 2026-05-14).
 *
 * Mounted at the top of /intel/reviews. Shows totals, source split,
 * 24-month volume trend, sentiment direction, and top themes. The
 * underlying phrase library + raw reviews list stays below.
 *
 * Pulls /api/intel/reviews/analytics.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  Star,
  TrendingUp,
  TrendingDown,
  Minus,
  Loader2,
  MessageSquare,
  Sparkles,
} from 'lucide-react'
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  LineChart,
  Line,
  CartesianGrid,
} from 'recharts'
import { EmptyState } from '@/components/ui/empty-state'

interface SourceRow {
  source: string
  count: number
  avg_rating: number | null
  share_pct: number
  with_response: number
}

interface MonthlyRow {
  month: string
  count: number
  avg_rating: number | null
  avg_sentiment: number | null
}

interface ThemeRow {
  theme: string
  count: number
}

interface Rollup {
  venue_id: string
  total: number
  avg_rating: number | null
  five_star_pct: number
  with_response_pct: number
  recent_30d_count: number
  recent_90d_count: number
  sources: SourceRow[]
  monthly: MonthlyRow[]
  top_themes: ThemeRow[]
  sentiment_trend: {
    recent_avg: number | null
    prior_avg: number | null
    direction: 'rising' | 'flat' | 'falling' | 'unknown'
  }
  solicitations: {
    gap_count: number
    total_12mo: number
    received_12mo: number
    no_response_12mo: number
    queued: number
    sent: number
    received_rate_pct: number | null
  }
}

const SOURCE_LABELS: Record<string, string> = {
  google: 'Google',
  the_knot: 'The Knot',
  wedding_wire: 'WeddingWire',
  zola: 'Zola',
  yelp: 'Yelp',
  facebook: 'Facebook',
  other: 'Other',
}

function monthShort(yyyymm: string): string {
  const [y, m] = yyyymm.split('-')
  const d = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1)
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

export function ReviewsOverviewPanel() {
  const [rollup, setRollup] = useState<Rollup | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [backfillResult, setBackfillResult] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/intel/reviews/analytics')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      setRollup(json.rollup)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const backfillGap = useCallback(async () => {
    setBackfilling(true)
    setBackfillResult(null)
    try {
      const res = await fetch('/api/intel/reviews/solicit-gap-backfill', {
        method: 'POST',
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setBackfillResult(
        `Queued ${json.enqueued} request${json.enqueued === 1 ? '' : 's'}, skipped ${json.skipped}. The drafter will turn each into a tailored ask within the next cron tick.`,
      )
      await load()
    } catch (e) {
      setBackfillResult(e instanceof Error ? e.message : 'Failed to backfill')
    } finally {
      setBackfilling(false)
    }
  }, [load])

  useEffect(() => {
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-sage-500 p-4">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading analytics…
      </div>
    )
  }
  if (error) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="Could not load review analytics"
        subtitle={error}
        variant="dashed"
      />
    )
  }
  if (!rollup || rollup.total === 0) {
    return (
      <EmptyState
        icon={MessageSquare}
        title="No reviews ingested yet"
        subtitle="Paste reviews on the Bulk Paste page or wait for the Google Places auto-pull to run."
        action={{ label: 'Bulk paste reviews', href: '/intel/reviews/paste' }}
      />
    )
  }

  const trend = rollup.sentiment_trend
  const TrendIcon =
    trend.direction === 'rising'
      ? TrendingUp
      : trend.direction === 'falling'
        ? TrendingDown
        : Minus
  const trendTone =
    trend.direction === 'rising'
      ? 'text-emerald-700'
      : trend.direction === 'falling'
        ? 'text-rose-700'
        : 'text-sage-700'

  return (
    <div className="space-y-5">
      {/* Headline tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile
          label="Total reviews"
          value={rollup.total.toLocaleString()}
          subtitle={`${rollup.recent_30d_count} in last 30d`}
        />
        <Tile
          label="Avg rating"
          value={rollup.avg_rating !== null ? rollup.avg_rating.toFixed(2) : '—'}
          icon={<Star className="w-4 h-4 text-amber-500" />}
          subtitle={`${Math.round(rollup.five_star_pct)}% 5-star`}
        />
        <Tile
          label="Response rate"
          value={`${Math.round(rollup.with_response_pct)}%`}
          subtitle="Reviews with your reply"
        />
        <Tile
          label="Sentiment trend"
          value={
            trend.direction === 'unknown'
              ? '—'
              : trend.direction.charAt(0).toUpperCase() + trend.direction.slice(1)
          }
          icon={<TrendIcon className={`w-4 h-4 ${trendTone}`} />}
          subtitle={
            trend.recent_avg !== null && trend.prior_avg !== null
              ? `${trend.recent_avg.toFixed(2)} now vs ${trend.prior_avg.toFixed(2)} prior 6m`
              : 'Needs ≥6 months of scored reviews'
          }
        />
      </div>

      {/* Source breakdown */}
      <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
        <h3 className="font-heading text-base font-semibold text-sage-900 mb-4">
          By source
        </h3>
        <ul className="space-y-2">
          {rollup.sources.map((s) => (
            <li key={s.source} className="flex items-center gap-3">
              <span className="w-24 text-sm text-sage-700 flex-shrink-0">
                {SOURCE_LABELS[s.source] ?? s.source}
              </span>
              <div className="flex-1 h-3 bg-sage-50 rounded overflow-hidden">
                <div
                  className="h-full bg-sage-500"
                  style={{ width: `${Math.max(2, s.share_pct)}%` }}
                />
              </div>
              <span className="text-xs text-sage-600 w-44 text-right flex-shrink-0">
                {s.count} · {s.avg_rating !== null ? `${s.avg_rating.toFixed(1)}★` : '—'} ·{' '}
                <span className="text-sage-500">
                  {Math.round((s.with_response / Math.max(1, s.count)) * 100)}% replied
                </span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Volume + sentiment trend */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-surface border border-border rounded-xl shadow-sm p-5">
          <h3 className="font-heading text-base font-semibold text-sage-900 mb-1">
            Volume (last 24 months)
          </h3>
          <p className="text-xs text-sage-500 mb-3">Number of reviews per month.</p>
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rollup.monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  tickFormatter={monthShort}
                  interval={Math.max(1, Math.floor(rollup.monthly.length / 6))}
                />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  labelFormatter={(label) =>
                    typeof label === 'string' ? monthShort(label) : String(label ?? '')
                  }
                  contentStyle={{ fontSize: 12 }}
                />
                <Bar dataKey="count" fill="#7D8471" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="bg-surface border border-border rounded-xl shadow-sm p-5">
          <h3 className="font-heading text-base font-semibold text-sage-900 mb-1">
            Avg rating per month
          </h3>
          <p className="text-xs text-sage-500 mb-3">
            1-5 stars. Drops below 4.5 are worth investigating.
          </p>
          <div style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={rollup.monthly}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11 }}
                  tickFormatter={monthShort}
                  interval={Math.max(1, Math.floor(rollup.monthly.length / 6))}
                />
                <YAxis
                  domain={[1, 5]}
                  tick={{ fontSize: 11 }}
                  tickCount={5}
                />
                <Tooltip
                  labelFormatter={(label) =>
                    typeof label === 'string' ? monthShort(label) : String(label ?? '')
                  }
                  contentStyle={{ fontSize: 12 }}
                />
                <Line
                  type="monotone"
                  dataKey="avg_rating"
                  stroke="#A6894A"
                  strokeWidth={2}
                  dot={{ r: 2 }}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Solicitation funnel + gap */}
      <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
        <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
          <div>
            <h3 className="font-heading text-base font-semibold text-sage-900 flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-sage-500" />
              Solicitations (last 12 months)
            </h3>
            <p className="text-xs text-sage-500 mt-0.5">
              Couples Sage asked to review you, and where they landed.
            </p>
          </div>
          {rollup.solicitations.gap_count > 0 ? (
            <button
              onClick={() => void backfillGap()}
              disabled={backfilling}
              className="inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-sage-600 text-white hover:bg-sage-700 disabled:opacity-50"
            >
              {backfilling ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : null}
              Solicit {rollup.solicitations.gap_count} eligible couple
              {rollup.solicitations.gap_count === 1 ? '' : 's'} now
            </button>
          ) : null}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Tile
            label="Gap"
            value={String(rollup.solicitations.gap_count)}
            subtitle="Booked, 7-30d post-event, never asked"
          />
          <Tile
            label="Queued"
            value={String(rollup.solicitations.queued)}
            subtitle="Drafted, waiting on send"
          />
          <Tile
            label="Sent"
            value={String(rollup.solicitations.sent)}
            subtitle="Awaiting response"
          />
          <Tile
            label="Received"
            value={String(rollup.solicitations.received_12mo)}
            subtitle={
              rollup.solicitations.received_rate_pct !== null
                ? `${Math.round(rollup.solicitations.received_rate_pct)}% conversion`
                : 'Not enough data'
            }
          />
          <Tile
            label="No response"
            value={String(rollup.solicitations.no_response_12mo)}
            subtitle="60+ days, no review"
          />
        </div>
        {backfillResult ? (
          <p className="text-xs text-sage-600 mt-3">{backfillResult}</p>
        ) : null}
      </section>

      {/* Themes */}
      {rollup.top_themes.length > 0 ? (
        <section className="bg-surface border border-border rounded-xl shadow-sm p-5">
          <h3 className="font-heading text-base font-semibold text-sage-900 mb-3 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-sage-500" />
            What couples mention most
          </h3>
          <div className="flex flex-wrap gap-2">
            {rollup.top_themes.map((t) => (
              <span
                key={t.theme}
                className="rounded-full border border-sage-200 bg-sage-50 px-3 py-1 text-xs text-sage-800 capitalize"
              >
                {t.theme} <span className="text-sage-500">· {t.count}</span>
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function Tile({
  label,
  value,
  subtitle,
  icon,
}: {
  label: string
  value: string
  subtitle?: string
  icon?: React.ReactNode
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-sage-500">{label}</span>
        {icon ?? null}
      </div>
      <div className="text-2xl font-semibold text-sage-900 mt-1">{value}</div>
      {subtitle ? <div className="text-xs text-sage-500 mt-0.5">{subtitle}</div> : null}
    </div>
  )
}
