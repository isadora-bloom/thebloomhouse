'use client'

/**
 * CohortRollupPanel — Wave 5B embeddable preview panel.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5B is the cohort intelligence layer
 *     derived from per-couple substrate)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5B spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
 *     themes show count-only badges, never name couples or quote
 *     evidence)
 *
 * Why a separate panel from the dashboard
 * ---------------------------------------
 * Wave 5C will surface this on the main /intel dashboard so coordinators
 * see "what's emerging across your cohort" without leaving their
 * existing landing surface. This panel renders the top-3 emerging
 * themes + top-3 conversion correlations and a link out to the full
 * /intel/cohort dashboard.
 *
 * Sensitivity gating
 * ------------------
 * Same doctrine as the rest of Wave 5: sensitive_filtered_count is the
 * ONLY signal we surface for sensitive themes. Coordinators do not see
 * which couples carry the flag from the cohort surface.
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  RefreshCw,
  Loader2,
  AlertCircle,
  Sparkles,
  ShieldAlert,
  ArrowUpRight,
} from 'lucide-react'

interface EmergingTheme {
  theme: string
  trend: 'rising' | 'steady' | 'declining'
  evidence_count: number
  evidence_window_days: number
  sensitivity_filtered_count: number
  summary: string
}

interface ConversionCorrelation {
  signal: string
  outcome: 'books' | 'drops' | 'slow'
  lift_pct: number
  n_couples: number
  confidence_0_100: number
  reasoning: string
}

interface CohortRollupOutput {
  emerging_themes: EmergingTheme[]
  conversion_correlations: ConversionCorrelation[]
  voice_calibration: unknown[]
  service_demand_map: unknown[]
  timing_patterns: unknown[]
  refusals: Array<{ field: string; reason: string }>
}

interface PanelResponse {
  ok: boolean
  venueId?: string
  rollup?: CohortRollupOutput
  sourceWindowDays?: number
  couplesInWindow?: number
  promptVersion?: string
  lastRefreshedAt?: string
  cumulativeCostCents?: number
  error?: string
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return 'unknown'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return 'unknown'
  const diffMs = Date.now() - t
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}

function trendIcon(trend: EmergingTheme['trend']) {
  if (trend === 'rising') return <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
  if (trend === 'declining') return <TrendingDown className="w-3.5 h-3.5 text-rose-600" />
  return <Minus className="w-3.5 h-3.5 text-sage-500" />
}

function outcomeColors(outcome: ConversionCorrelation['outcome']) {
  if (outcome === 'books') {
    return {
      pill: 'bg-emerald-50 border-emerald-200 text-emerald-700',
      label: 'books',
    }
  }
  if (outcome === 'drops') {
    return {
      pill: 'bg-rose-50 border-rose-200 text-rose-700',
      label: 'drops',
    }
  }
  return {
    pill: 'bg-amber-50 border-amber-200 text-amber-700',
    label: 'slow',
  }
}

function fmtLift(lift: number): string {
  if (lift === 0) return 'baseline'
  const sign = lift > 0 ? '+' : ''
  // lift_pct is relative to baseline. Render as a multiplier when it
  // makes sense, percent otherwise.
  const ratio = 1 + lift / 100
  if (ratio > 0) {
    return `${sign}${Math.round(lift)}% (${ratio.toFixed(2)}x)`
  }
  return `${sign}${Math.round(lift)}%`
}

export function CohortRollupPanel() {
  const [data, setData] = useState<PanelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const fetchRollup = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/intel/cohort-rollup', {
        cache: 'no-store',
      })
      if (res.status === 404) {
        setData({ ok: false, error: 'no-rollup' })
        setError(null)
        return
      }
      const body = (await res.json()) as PanelResponse
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        setData(null)
        return
      }
      setData(body)
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(msg)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchRollup().finally(() => setLoading(false))
  }, [fetchRollup])

  async function refresh(force: boolean) {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/cohort-rollup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      const body = (await res.json()) as PanelResponse
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      setData(body)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(msg)
    } finally {
      setRefreshing(false)
    }
  }

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Cohort intelligence
          </h2>
          <Loader2 className="w-3.5 h-3.5 ml-auto text-sage-400 animate-spin" />
        </div>
        <div className="p-6 text-sm text-sage-500">Loading rollup...</div>
      </div>
    )
  }

  if (!data || (!data.rollup && data.error === 'no-rollup')) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Cohort intelligence
          </h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-sage-600 mb-3">
            No rollup yet — generate one now to surface emerging themes and
            conversion correlations across your last-90-day cohort.
          </p>
          <button
            type="button"
            onClick={() => refresh(false)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-3 py-1.5 text-sm bg-sage-500 text-white rounded-md hover:bg-sage-600 disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            {refreshing ? 'Generating...' : 'Generate rollup'}
          </button>
          {error && (
            <p className="mt-3 text-xs text-rose-600 flex items-center gap-1">
              <AlertCircle className="w-3 h-3" /> {error}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (error && !data.rollup) {
    return (
      <div className="bg-surface border border-rose-200 rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-500" />
          <h2 className="font-heading text-base font-semibold text-rose-700">
            Cohort intelligence — failed to load
          </h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      </div>
    )
  }

  const rollup = data.rollup!
  const topThemes = rollup.emerging_themes.slice(0, 3)
  const topCorrelations = [...rollup.conversion_correlations]
    .sort((a, b) => Math.abs(b.lift_pct) - Math.abs(a.lift_pct))
    .slice(0, 3)

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-border flex items-center gap-3 flex-wrap">
        <Sparkles className="w-4 h-4 text-sage-500" />
        <h2 className="font-heading text-base font-semibold text-sage-900">
          Cohort intelligence
        </h2>
        <span className="text-xs text-sage-500">
          {data.couplesInWindow ?? 0} couples · last {data.sourceWindowDays ?? 90}d
        </span>
        <Link
          href="/intel/cohort"
          className="ml-auto inline-flex items-center gap-1 text-xs text-sage-700 hover:text-sage-900 hover:underline"
        >
          Full dashboard
          <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      {topThemes.length > 0 && (
        <div className="px-6 py-3 border-b border-border">
          <div className="text-xs uppercase tracking-wide font-semibold text-sage-700 mb-2">
            Top emerging themes
          </div>
          <ul className="space-y-2">
            {topThemes.map((t, i) => (
              <li key={i} className="text-sm flex items-start gap-2">
                {trendIcon(t.trend)}
                <div className="flex-1">
                  <div className="font-medium text-sage-900">
                    {t.theme}
                    <span className="ml-2 text-[11px] font-normal text-sage-500">
                      n={t.evidence_count}
                    </span>
                    {t.sensitivity_filtered_count > 0 && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 text-[10px] text-rose-700 bg-rose-50 border border-rose-100 px-1.5 py-0.5 rounded"
                        title="Sensitive themes are reported as counts only — never named couples or quoted evidence."
                      >
                        <ShieldAlert className="w-2.5 h-2.5" />
                        {t.sensitivity_filtered_count} sensitive
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-sage-600 leading-snug mt-0.5">
                    {t.summary}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {topCorrelations.length > 0 && (
        <div className="px-6 py-3 border-b border-border">
          <div className="text-xs uppercase tracking-wide font-semibold text-sage-700 mb-2">
            Top conversion correlations
          </div>
          <ul className="space-y-2">
            {topCorrelations.map((c, i) => {
              const colors = outcomeColors(c.outcome)
              return (
                <li key={i} className="text-sm flex items-start gap-2">
                  <Target className="w-3.5 h-3.5 text-sage-500 mt-0.5" />
                  <div className="flex-1">
                    <div className="flex items-baseline flex-wrap gap-2">
                      <span className="font-medium text-sage-900">{c.signal}</span>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${colors.pill}`}
                      >
                        {colors.label} · {fmtLift(c.lift_pct)}
                      </span>
                      <span className="text-[10px] text-sage-500">
                        n={c.n_couples} · {c.confidence_0_100}% conf
                      </span>
                    </div>
                    <div className="text-xs text-sage-600 leading-snug mt-0.5">
                      {c.reasoning}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <div className="px-6 py-3 bg-sage-50/30 flex items-center gap-3 text-[11px] text-sage-500">
        <span>Last refreshed {relativeTime(data.lastRefreshedAt)}</span>
        {data.promptVersion && (
          <span className="font-mono text-sage-400">{data.promptVersion}</span>
        )}
        <button
          type="button"
          onClick={() => refresh(true)}
          disabled={refreshing}
          className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 text-[11px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
          title="Force a fresh Sonnet aggregate. Use when new couples have been booked or new signals have landed."
        >
          {refreshing ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <RefreshCw className="w-3 h-3" />
          )}
          Refresh
        </button>
      </div>
      {error && (
        <div className="px-6 py-2 text-xs text-rose-600 border-t border-rose-100 bg-rose-50/40 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </div>
      )}
    </div>
  )
}
