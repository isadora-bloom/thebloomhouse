'use client'

/**
 * /intel/cohort — Wave 5B cohort intelligence dashboard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5B aggregates the per-couple substrate
 *     into venue-level intel: emerging themes, conversion correlations,
 *     voice calibration, service demand, timing patterns)
 *   - bloom-wave4-5-6-master-plan.md (5B spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
 *     themes show count-only badges, never name couples or quote
 *     evidence)
 *
 * Sensitivity gating
 * ------------------
 * sensitivity_filtered_count is the only signal we surface for
 * sensitive themes on the coordinator surface. Even with
 * venue_config.feature_flags.reveal_sensitive_themes=true the
 * aggregator never produced couple-level evidence — the prompt's
 * input was already stripped. So this surface has no per-couple raw
 * quotes to gate on.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Sparkles,
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  Mic,
  Package,
  Clock,
  ShieldAlert,
  RefreshCw,
  Loader2,
  AlertCircle,
  CheckCircle2,
  XCircle,
  HelpCircle,
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

interface VoiceCalibration {
  persona_label: string
  language_that_lands: string[]
  language_to_avoid: string[]
  evidence_summary: string
}

interface ServiceDemandEntry {
  service_or_offering: string
  demand_signal: string
  currently_offered: 'yes' | 'no' | 'unknown'
  investment_recommendation: string
}

interface TimingPattern {
  pattern: string
  evidence_summary: string
  actionable_recommendation: string
}

interface CohortRollupOutput {
  emerging_themes: EmergingTheme[]
  conversion_correlations: ConversionCorrelation[]
  voice_calibration: VoiceCalibration[]
  service_demand_map: ServiceDemandEntry[]
  timing_patterns: TimingPattern[]
  refusals: Array<{ field: string; reason: string }>
}

interface PageResponse {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  if (trend === 'rising') {
    return <TrendingUp className="w-4 h-4 text-emerald-600" />
  }
  if (trend === 'declining') {
    return <TrendingDown className="w-4 h-4 text-rose-600" />
  }
  return <Minus className="w-4 h-4 text-sage-500" />
}

function trendLabel(trend: EmergingTheme['trend']): string {
  return { rising: 'Rising', steady: 'Steady', declining: 'Declining' }[trend]
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
  const ratio = 1 + lift / 100
  if (ratio > 0) {
    return `${sign}${Math.round(lift)}% (${ratio.toFixed(2)}x)`
  }
  return `${sign}${Math.round(lift)}%`
}

function offeredIcon(offered: ServiceDemandEntry['currently_offered']) {
  if (offered === 'yes') return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
  if (offered === 'no') return <XCircle className="w-3.5 h-3.5 text-rose-600" />
  return <HelpCircle className="w-3.5 h-3.5 text-sage-500" />
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CohortIntelDashboard() {
  const [data, setData] = useState<PageResponse | null>(null)
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
      const body = (await res.json()) as PageResponse
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
      const body = (await res.json()) as PageResponse
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
      <div className="space-y-4">
        <div className="h-32 bg-sage-50 rounded-xl animate-pulse" />
        <div className="h-64 bg-sage-50 rounded-xl animate-pulse" />
      </div>
    )
  }

  // Empty state — no rollup ever generated.
  if (!data || (!data.rollup && data.error === 'no-rollup')) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            Cohort intelligence
          </h1>
          <p className="text-sm text-sage-600 mt-1">
            What&apos;s emerging across your couples in the last 90 days.
          </p>
        </div>
        <div className="bg-surface border border-border rounded-xl p-12 text-center shadow-sm">
          <Sparkles className="w-10 h-10 text-sage-400 mx-auto mb-3" />
          <p className="text-sage-700 font-medium">No rollup yet</p>
          <p className="text-sage-500 text-sm mt-2 max-w-md mx-auto">
            Generate a cohort rollup to see emerging themes, conversion
            correlations, voice calibration, service demand gaps, and timing
            patterns across your couples.
          </p>
          <button
            type="button"
            onClick={() => refresh(false)}
            disabled={refreshing}
            className="mt-6 inline-flex items-center gap-2 px-4 py-2 text-sm bg-sage-600 text-white rounded-lg hover:bg-sage-700 disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            {refreshing ? 'Generating rollup...' : 'Generate rollup now'}
          </button>
          {error && (
            <p className="mt-4 text-xs text-rose-600 flex items-center justify-center gap-1">
              <AlertCircle className="w-3 h-3" /> {error}
            </p>
          )}
        </div>
      </div>
    )
  }

  if (error && !data.rollup) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            Cohort intelligence
          </h1>
        </div>
        <div className="bg-surface border border-rose-200 rounded-xl p-6 shadow-sm">
          <p className="text-sm text-rose-700 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Failed to load rollup: {error}
          </p>
        </div>
      </div>
    )
  }

  const rollup = data.rollup!

  // Sort correlations by absolute lift_pct desc.
  const sortedCorrelations = [...rollup.conversion_correlations].sort(
    (a, b) => Math.abs(b.lift_pct) - Math.abs(a.lift_pct),
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            Cohort intelligence
          </h1>
          <p className="text-sm text-sage-600 mt-1">
            What&apos;s emerging, converting, and stuck across your couples.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-sage-600">
          <span>
            <span className="font-medium text-sage-900">
              {data.couplesInWindow ?? 0}
            </span>{' '}
            couples
          </span>
          <span>·</span>
          <span>
            last <span className="font-medium text-sage-900">{data.sourceWindowDays ?? 90}</span> days
          </span>
          <span>·</span>
          <span>refreshed {relativeTime(data.lastRefreshedAt)}</span>
          <button
            type="button"
            onClick={() => refresh(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-sage-300 text-sage-700 rounded-md hover:bg-sage-50 disabled:opacity-50"
            title="Force a fresh Sonnet aggregate. Cost ~$2-5."
          >
            {refreshing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-2 text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Refusal summary banner — when sections are empty. */}
      {rollup.refusals.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-xs text-amber-800">
          <div className="font-medium mb-1">Audit notes</div>
          <ul className="space-y-0.5">
            {rollup.refusals.map((r, i) => (
              <li key={i}>
                <span className="font-mono text-amber-700">{r.field}</span>: {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Emerging themes */}
      <section className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Emerging themes
          </h2>
          <span className="text-xs text-sage-500 ml-auto">
            {rollup.emerging_themes.length} surfaced
          </span>
        </div>
        {rollup.emerging_themes.length === 0 ? (
          <div className="px-6 py-6 text-sm text-sage-500">
            No themes yet. The aggregator surfaces themes that appear across ≥3
            couples.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rollup.emerging_themes.map((t, i) => (
              <li key={i} className="px-6 py-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">{trendIcon(t.trend)}</div>
                  <div className="flex-1">
                    <div className="flex items-baseline flex-wrap gap-2">
                      <span className="font-medium text-sage-900">{t.theme}</span>
                      <span className="text-[11px] text-sage-500 italic">
                        {trendLabel(t.trend)}
                      </span>
                      <span className="text-[11px] text-sage-500">
                        n={t.evidence_count} · {t.evidence_window_days}d window
                      </span>
                      {t.sensitivity_filtered_count > 0 && (
                        <span
                          className="inline-flex items-center gap-1 text-[11px] text-rose-700 bg-rose-50 border border-rose-100 px-1.5 py-0.5 rounded"
                          title="Sensitive themes are reported as counts only — never named couples or quoted evidence. Aggregate ≠ disclose."
                        >
                          <ShieldAlert className="w-3 h-3" />
                          {t.sensitivity_filtered_count} sensitive note
                          {t.sensitivity_filtered_count === 1 ? '' : 's'} —
                          coordinator-eyes-only
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-sage-700 leading-snug mt-1">
                      {t.summary}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Conversion correlations */}
      <section className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Target className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            What&apos;s converting
          </h2>
          <span className="text-xs text-sage-500 ml-auto">
            sorted by lift magnitude
          </span>
        </div>
        {sortedCorrelations.length === 0 ? (
          <div className="px-6 py-6 text-sm text-sage-500">
            No correlations surfaced yet. Need at least 3 couples per signal
            for a stable lift estimate.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {sortedCorrelations.map((c, i) => {
              const colors = outcomeColors(c.outcome)
              return (
                <li key={i} className="px-6 py-4">
                  <div className="flex items-start gap-3">
                    <Target className="w-4 h-4 text-sage-400 mt-0.5" />
                    <div className="flex-1">
                      <div className="flex items-baseline flex-wrap gap-2">
                        <span className="font-medium text-sage-900">
                          {c.signal}
                        </span>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${colors.pill}`}
                        >
                          {colors.label} · {fmtLift(c.lift_pct)}
                        </span>
                        <span className="text-[11px] text-sage-500">
                          n={c.n_couples} · {c.confidence_0_100}% conf
                        </span>
                      </div>
                      <p className="text-sm text-sage-700 leading-snug mt-1">
                        {c.reasoning}
                      </p>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* Voice that lands */}
      <section className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Mic className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Voice that lands
          </h2>
          <span className="text-xs text-sage-500 ml-auto">
            per persona · Wave 5C will pipe this into Sage drafts
          </span>
        </div>
        {rollup.voice_calibration.length === 0 ? (
          <div className="px-6 py-6 text-sm text-sage-500">
            No voice calibration yet. Need ≥3 couples per persona for a stable
            language pattern.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rollup.voice_calibration.map((v, i) => (
              <li key={i} className="px-6 py-4">
                <div className="font-medium text-sage-900 mb-2">
                  {v.persona_label}
                </div>
                <p className="text-xs text-sage-600 leading-snug mb-3 italic">
                  {v.evidence_summary}
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="bg-emerald-50/40 border border-emerald-100 rounded-lg p-3">
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-emerald-700 mb-2">
                      Lands
                    </div>
                    <ul className="space-y-1 text-sm text-sage-800">
                      {v.language_that_lands.map((l, j) => (
                        <li key={j} className="flex items-start gap-2">
                          <span className="text-emerald-500 mt-0.5">+</span>
                          <span>{l}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="bg-rose-50/40 border border-rose-100 rounded-lg p-3">
                    <div className="text-[10px] uppercase tracking-wide font-semibold text-rose-700 mb-2">
                      Avoid
                    </div>
                    <ul className="space-y-1 text-sm text-sage-800">
                      {v.language_to_avoid.map((l, j) => (
                        <li key={j} className="flex items-start gap-2">
                          <span className="text-rose-500 mt-0.5">−</span>
                          <span>{l}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Service demand */}
      <section className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Package className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Service demand gaps
          </h2>
        </div>
        {rollup.service_demand_map.length === 0 ? (
          <div className="px-6 py-6 text-sm text-sage-500">
            No demand signals surfaced yet. The aggregator looks for repeated
            asks the venue may not currently offer.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rollup.service_demand_map.map((s, i) => (
              <li key={i} className="px-6 py-4">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5">{offeredIcon(s.currently_offered)}</div>
                  <div className="flex-1">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="font-medium text-sage-900">
                        {s.service_or_offering}
                      </span>
                      <span className="text-[11px] text-sage-500 italic">
                        currently offered: {s.currently_offered}
                      </span>
                    </div>
                    <p className="text-sm text-sage-700 leading-snug mt-1">
                      <span className="text-sage-500">Demand: </span>
                      {s.demand_signal}
                    </p>
                    <p className="text-sm text-sage-800 leading-snug mt-1">
                      <span className="text-sage-500">→ </span>
                      {s.investment_recommendation}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Timing patterns */}
      <section className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Clock className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Timing patterns
          </h2>
        </div>
        {rollup.timing_patterns.length === 0 ? (
          <div className="px-6 py-6 text-sm text-sage-500">
            No timing patterns surfaced yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rollup.timing_patterns.map((t, i) => (
              <li key={i} className="px-6 py-4">
                <div className="flex items-start gap-3">
                  <Clock className="w-4 h-4 text-sage-400 mt-0.5" />
                  <div className="flex-1">
                    <div className="font-medium text-sage-900">{t.pattern}</div>
                    <p className="text-xs text-sage-600 leading-snug mt-1 italic">
                      {t.evidence_summary}
                    </p>
                    <p className="text-sm text-sage-800 leading-snug mt-2">
                      <span className="text-sage-500">→ </span>
                      {t.actionable_recommendation}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Footer with prompt version */}
      <div className="text-[10px] text-sage-400 font-mono text-center pt-4">
        {data.promptVersion}
      </div>
    </div>
  )
}
