'use client'

/**
 * /intel/macro-correlations — T5-θ.1, USP #4 demo surface.
 *
 * Renders LLM-narrated cross-limb correlations as cards. Each card
 * shows the plain-English story Bloom's correlation engine + cultural-
 * moments + FRED indicator stack uncovered, with a weak-signal badge
 * when r<0.3 or p>0.05 and a "view raw series" expandable for the
 * 30-day daily values that backed the narration.
 *
 * The page is the headline answer to "show me one real macro
 * correlation Bloom surfaced this month" (yc-partner.md CRITICAL #2).
 *
 * First load: read the cache (existing correlation_narration rows).
 * Second click on Refresh: trigger the LLM narration for any new
 * correlation rows the engine wrote since the last narration. Gated
 * by cost-ceiling at both the route and service layers.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Sparkles,
  TrendingUp,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCcw,
  Clock,
  Pause,
} from 'lucide-react'

interface NarratedCorrelation {
  id: string
  correlationId: string
  channelA: string
  channelB: string
  channelALabel: string
  channelBLabel: string
  lagDays: number
  r: number
  pValue: number
  weakSignal: boolean
  title: string
  body: string
  action: string | null
  confidence: number
  cached: boolean
  createdAt: string
  seriesA: Array<{ dayKey: string; value: number }>
  seriesB: Array<{ dayKey: string; value: number }>
}

interface ApiResponse {
  narrations: NarratedCorrelation[]
  paused: boolean
  pausedReason?: string
  resumesAt?: string
  generated: boolean
  generatedCount?: number
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  } catch {
    return iso
  }
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '--'
  if (Math.abs(v) >= 1000) return v.toFixed(0)
  if (Math.abs(v) >= 10) return v.toFixed(1)
  return v.toFixed(2)
}

// ---------------------------------------------------------------------------
// Mini sparkline. Renders a tiny SVG line for the recent-values series.
// Pure presentational, no axis ticks — the expandable below shows the
// numbers. The point of the sparkline is shape, not precision.
// ---------------------------------------------------------------------------

function Sparkline({
  points,
  color,
}: {
  points: Array<{ dayKey: string; value: number }>
  color: string
}) {
  if (!points.length) {
    return <div className="text-xs text-sage-400">No data</div>
  }
  const values = points.map((p) => p.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const width = 200
  const height = 36
  const path = points
    .map((p, i) => {
      const x = (i / Math.max(1, points.length - 1)) * width
      const y = height - ((p.value - min) / range) * height
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={path} stroke={color} strokeWidth={1.5} fill="none" />
    </svg>
  )
}

// ---------------------------------------------------------------------------
// Card — one narrated correlation.
// ---------------------------------------------------------------------------

function NarrationCard({ n }: { n: NarratedCorrelation }) {
  const [expanded, setExpanded] = useState(false)
  const directionLabel =
    n.r >= 0 ? 'rose together' : 'moved opposite'
  const lagLabel =
    n.lagDays === 0 ? 'same-day' : `${n.lagDays}-day lag`

  return (
    <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
      {/* Header row — title + weak-signal badge */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2 flex-1 min-w-0">
          <div className={n.weakSignal ? 'bg-gray-50 p-2 rounded-lg' : 'bg-sage-50 p-2 rounded-lg'}>
            {n.weakSignal ? (
              <AlertTriangle className="w-4 h-4 text-gray-500" />
            ) : (
              <Sparkles className="w-4 h-4 text-sage-600" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-sage-900 leading-snug">
              {n.title}
            </h3>
            <p className="text-xs text-muted mt-0.5">
              {n.channelALabel} <span className="opacity-50">•</span> {n.channelBLabel}
            </p>
          </div>
        </div>
        {n.weakSignal && (
          <span className="px-2 py-0.5 text-[10px] uppercase tracking-wide font-medium bg-gray-100 text-gray-600 rounded shrink-0">
            Weak signal
          </span>
        )}
      </div>

      {/* Narration body */}
      <p className="text-sm text-sage-700 leading-relaxed">{n.body}</p>

      {/* Action callout if present */}
      {n.action && !n.weakSignal && (
        <div className="bg-sage-50/60 border border-sage-100 rounded-lg px-3 py-2">
          <p className="text-xs font-medium text-sage-700">
            <span className="text-sage-500 uppercase tracking-wide">Action</span>{' '}
            <span className="text-sage-800">{n.action}</span>
          </p>
        </div>
      )}

      {/* Stat strip */}
      <div className="flex items-center gap-4 text-xs text-sage-500 pt-1">
        <span className="flex items-center gap-1">
          <TrendingUp className="w-3 h-3" />
          r = {n.r.toFixed(2)} ({directionLabel})
        </span>
        <span className="flex items-center gap-1">
          <Clock className="w-3 h-3" />
          {lagLabel}
        </span>
        <span>p ≈ {n.pValue.toFixed(3)}</span>
        <span className="ml-auto opacity-70">
          {formatDate(n.createdAt)}
        </span>
      </div>

      {/* Raw series expandable */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1 text-xs text-sage-500 hover:text-sage-700"
      >
        {expanded ? (
          <ChevronUp className="w-3 h-3" />
        ) : (
          <ChevronDown className="w-3 h-3" />
        )}
        {expanded ? 'Hide raw series' : 'View raw series'}
      </button>

      {expanded && (
        <div className="bg-sage-50/30 border border-sage-100 rounded-lg p-3 space-y-3">
          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium text-sage-700">{n.channelALabel}</p>
              <p className="text-xs text-sage-500">
                {n.seriesA.length} day{n.seriesA.length === 1 ? '' : 's'}
              </p>
            </div>
            <Sparkline points={n.seriesA} color="#7D8471" />
            <details className="mt-1">
              <summary className="text-[10px] text-sage-500 cursor-pointer hover:text-sage-700">
                Daily values
              </summary>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 mt-1 font-mono text-[11px] text-sage-600">
                {n.seriesA.slice(-30).map((p) => (
                  <div key={p.dayKey} className="flex justify-between">
                    <span className="opacity-60">{p.dayKey}</span>
                    <span>{formatNumber(p.value)}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
          <div className="border-t border-sage-100 pt-3">
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-medium text-sage-700">{n.channelBLabel}</p>
              <p className="text-xs text-sage-500">
                {n.seriesB.length} day{n.seriesB.length === 1 ? '' : 's'}
              </p>
            </div>
            <Sparkline points={n.seriesB} color="#5D7A7A" />
            <details className="mt-1">
              <summary className="text-[10px] text-sage-500 cursor-pointer hover:text-sage-700">
                Daily values
              </summary>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 mt-1 font-mono text-[11px] text-sage-600">
                {n.seriesB.slice(-30).map((p) => (
                  <div key={p.dayKey} className="flex justify-between">
                    <span className="opacity-60">{p.dayKey}</span>
                    <span>{formatNumber(p.value)}</span>
                  </div>
                ))}
              </div>
            </details>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function MacroCorrelationsPage() {
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (refresh: boolean) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams()
      if (refresh) params.set('refresh', 'true')
      const res = await fetch(
        `/api/intel/macro-correlations${params.size ? `?${params}` : ''}`,
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const json = (await res.json()) as ApiResponse
      setData(json)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load(false)
  }, [load])

  const sorted = useMemo(() => {
    if (!data) return []
    return [...data.narrations].sort((a, b) => {
      // Strong signals first.
      if (a.weakSignal !== b.weakSignal) return a.weakSignal ? 1 : -1
      return Math.abs(b.r) - Math.abs(a.r)
    })
  }, [data])

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
            Macro Correlations
          </h1>
          <p className="text-sage-600 max-w-3xl">
            Cross-channel stories Bloom found in your data. Every card
            connects an external macro signal (mortgage rates, cultural
            moments, holidays) or one of your internal channels (Instagram,
            Pinterest, The Knot views) to a downstream effect on inquiries
            or tour completions, with the lag and strength shown alongside
            the plain-English narration.
          </p>
        </div>
        <button
          onClick={() => load(true)}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-sage-200 text-sage-700 hover:bg-sage-50 disabled:opacity-50 shrink-0"
        >
          {refreshing ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCcw className="w-4 h-4" />
          )}
          {refreshing ? 'Refreshing...' : 'Refresh narrations'}
        </button>
      </div>

      {/* Cost-ceiling paused banner */}
      {data?.paused && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <Pause className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
          <div className="flex-1 text-sm text-amber-800">
            <p className="font-medium">Autonomous insight generation is paused.</p>
            <p className="mt-1 text-amber-700">
              Showing previously-generated narrations. New narrations will
              resume{data.resumesAt ? ` at ${formatDate(data.resumesAt)}` : ' once daily ceiling resets'}.
            </p>
          </div>
        </div>
      )}

      {/* Generation feedback */}
      {data?.generated && !data.paused && data.generatedCount !== undefined && (
        <div className="bg-sage-50/60 border border-sage-100 rounded-lg px-3 py-2 text-xs text-sage-700">
          {data.generatedCount > 0
            ? `Refreshed ${data.generatedCount} narration${data.generatedCount === 1 ? '' : 's'}.`
            : 'No new correlations needed narration; cache is current.'}
        </div>
      )}

      {/* Body */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 text-sage-400 animate-spin" />
        </div>
      ) : error ? (
        <div className="bg-rose-50 border border-rose-200 rounded-xl p-6 text-center">
          <p className="text-rose-700 font-medium">Couldn't load narrations</p>
          <p className="text-sm text-rose-600 mt-1">{error}</p>
        </div>
      ) : sorted.length === 0 ? (
        <div className="bg-surface border border-border rounded-xl p-12 text-center">
          <Sparkles className="w-8 h-8 text-sage-300 mx-auto mb-3" />
          <p className="text-sage-600 font-medium">
            No macro correlations narrated yet
          </p>
          <p className="text-sm text-muted mt-1 max-w-md mx-auto">
            Bloom's correlation engine surfaces cross-limb stories as your
            data accumulates. Click Refresh to narrate the most recent
            engine findings, or wait for the daily cron.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {sorted.map((n) => (
            <NarrationCard key={n.id} n={n} />
          ))}
        </div>
      )}

      {/* Footer note */}
      <p className="text-xs text-sage-500 max-w-3xl pt-2">
        Narrations are generated by Bloom's brain (Claude Sonnet) using the
        Pearson correlation, the lag in days, and each channel's recent
        values as inputs. The brain is forbidden from inventing numbers —
        every quantitative claim in a card came from the underlying
        classical computation. Weak signals (r below 0.3 or p above 0.05)
        are flagged but still surfaced so you can see what the platform is
        watching.
      </p>
    </div>
  )
}
