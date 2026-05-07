'use client'

import { useState, useEffect, useCallback } from 'react'
import { Flame, MessageCircle, AlertTriangle, TrendingDown, Users, RefreshCw, Loader2 } from 'lucide-react'
import { PriorTouchesBadge } from '@/components/intel/inline-primitives'
import type { PriorTouchSummary } from '@/lib/services/intel/prior-touches'

// ---------------------------------------------------------------------------
// Lead insights panel — renders the 3 T3 generators (heat narration,
// negotiation state, risk flags) for a single wedding. Used on the
// lead detail page (/intel/clients/[id]) and as a hover-expansion on
// /agent/leads.
//
// Self-contained: takes a weddingId, fetches /api/insights/lead/[id]
// once, renders. Coordinator-facing "Refresh" button calls the same
// endpoint with ?refresh=1 to bypass cache. Loading + error states
// handled inline.
// ---------------------------------------------------------------------------

interface HeatInsight {
  title: string
  body: string
  action: string | null
  confidence: number
  cached: boolean
}

interface NegotiationInsight {
  phase: string
  phase_label: string
  reasoning: string
  confidence: number
  cached: boolean
}

interface RiskFlag {
  code: string
  severity: number
  evidence: string
}

interface RiskInsight {
  risk_score: number
  flags: RiskFlag[]
  flag_labels: string[]
  summary: string
  action: string | null
  confidence: number
  cached: boolean
}

interface DecayInsight {
  cause: string
  cause_label: string
  reasoning: string
  recommendation: string
  decline_magnitude: number
  days_since_last_inbound: number | null
  unresolved_questions: string[]
  confidence: number
  cached: boolean
}

interface CohortInsight {
  pattern: 'high_converting' | 'low_converting' | 'mixed' | 'sparse_signal'
  reasoning: string
  recommendation: string
  n_total: number
  n_booked: number
  n_lost: number
  conversion_pct: number
  median_booking_value: number | null
  median_days_to_book: number | null
  // T5-γ.1: cohort confidence disclosure. Backend exposes the
  // high/low split so this panel can render an honest "based on N
  // high-fidelity + M backfilled-low" caption rather than presenting
  // the cohort as homogeneous.
  n_low_confidence?: number
  n_high_confidence?: number
  confidence: number
  cached: boolean
}

interface InsightsResponse {
  weddingId: string
  venueId: string
  status: string
  heat: HeatInsight | null
  negotiation: NegotiationInsight | null
  risk: RiskInsight | null
  decay: DecayInsight | null
  cohort: CohortInsight | null
  errors: Array<{ insight: string; error: string }>
}

export interface LeadInsightsPanelProps {
  weddingId: string
  /** Compact = single-line summaries. Full = stacked cards with body text. */
  variant?: 'compact' | 'full'
}

function confidenceLabel(value: number): string {
  if (value >= 0.7) return 'High'
  if (value >= 0.45) return 'Medium'
  return 'Low'
}

function confidenceColor(value: number): string {
  if (value >= 0.7) return 'text-emerald-700 bg-emerald-50'
  if (value >= 0.45) return 'text-amber-700 bg-amber-50'
  return 'text-sage-500 bg-sage-50'
}

function riskBadgeColor(score: number): string {
  if (score >= 70) return 'bg-red-50 text-red-700 border-red-200'
  if (score >= 40) return 'bg-amber-50 text-amber-700 border-amber-200'
  if (score > 0) return 'bg-sage-50 text-sage-600 border-sage-200'
  return 'bg-emerald-50 text-emerald-700 border-emerald-200'
}

export function LeadInsightsPanel({ weddingId, variant = 'full' }: LeadInsightsPanelProps) {
  const [data, setData] = useState<InsightsResponse | null>(null)
  const [priorTouches, setPriorTouches] = useState<PriorTouchSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchInsights = useCallback(async (refresh: boolean = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    try {
      // T5-eta.3 + T5-gamma.4: mint a per-click correlation id and
      // thread it through the insights URL so every api_cost /
      // intelligence_insights / engagement_event created during this
      // generator run can be queried back via the same id. Parallel-
      // fetch prior touches alongside the insights bundle (INV-8.5.5
      // distinguishes "we looked, found nothing" from "we didn't look").
      const cid =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `cid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      const params = new URLSearchParams()
      if (refresh) params.set('refresh', '1')
      params.set('correlationId', cid)
      const insightsUrl = `/api/insights/lead/${weddingId}?${params.toString()}`
      const [insRes, ptRes] = await Promise.all([
        fetch(insightsUrl),
        fetch(`/api/insights/lead/${weddingId}/prior-touches`),
      ])
      if (!insRes.ok) throw new Error(`HTTP ${insRes.status}`)
      const json = (await insRes.json()) as InsightsResponse
      setData(json)
      setError(null)
      if (ptRes.ok) {
        const pt = (await ptRes.json()) as PriorTouchSummary | { error: string }
        if ('touches' in pt) setPriorTouches(pt)
        else setPriorTouches(null)
      } else {
        setPriorTouches(null)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load insights')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [weddingId])

  useEffect(() => { fetchInsights(false) }, [fetchInsights])

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-sage-500 py-3">
        <Loader2 className="w-3 h-3 animate-spin" />
        Loading insights…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="text-xs text-sage-400 italic py-2">
        Insights unavailable{error ? ` — ${error}` : ''}
      </div>
    )
  }

  if (variant === 'compact') {
    return (
      <div className="flex items-center gap-2 flex-wrap text-xs">
        {data.heat && (
          <span className="inline-flex items-center gap-1 text-sage-700">
            <Flame className="w-3 h-3" />
            {data.heat.title}
          </span>
        )}
        {data.negotiation && (
          <span className="inline-flex items-center gap-1 text-sage-700">
            <MessageCircle className="w-3 h-3" />
            {data.negotiation.phase_label}
          </span>
        )}
        {data.risk && data.risk.risk_score > 0 && (
          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium ${riskBadgeColor(data.risk.risk_score)}`}>
            <AlertTriangle className="w-3 h-3" />
            Risk {data.risk.risk_score}
          </span>
        )}
        {data.decay && (
          <span className="inline-flex items-center gap-1 text-amber-700">
            <TrendingDown className="w-3 h-3" />
            {data.decay.cause_label}
          </span>
        )}
        {data.cohort && (
          <span className="inline-flex items-center gap-1 text-sage-700">
            <Users className="w-3 h-3" />
            {data.cohort.n_booked}/{data.cohort.n_total} booked
          </span>
        )}
      </div>
    )
  }

  // T5-γ.4: surface prior-touch count above heat narration. Uses the
  // shared PriorTouchesBadge primitive — same numbers as the inbox
  // PriorTouchesChip, just rendered inline (no expand-on-click since
  // lead detail already shows the touch trail in WeddingJourney).
  const priorTouchCount = priorTouches?.touches.length ?? 0
  const priorTouchPlatforms = priorTouches
    ? Array.from(new Set(priorTouches.touches.map((t) => t.source))).slice(0, 4)
    : []

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sage-900 text-sm">Lead insights</h3>
        <div className="flex items-center gap-3">
          {priorTouches && (
            <PriorTouchesBadge
              count={priorTouchCount}
              platforms={priorTouchPlatforms}
            />
          )}
          <button
            onClick={() => fetchInsights(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-1 text-xs text-sage-500 hover:text-sage-700 disabled:opacity-50"
            title="Force regenerate (bypasses cache)"
          >
            <RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {data.heat && (
        <div className="rounded-lg border border-sage-200 bg-warm-white p-3 space-y-1">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Flame className="w-4 h-4 text-sage-700" />
              <span className="text-sm font-medium text-sage-900">{data.heat.title}</span>
            </div>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${confidenceColor(data.heat.confidence)}`}>
              {confidenceLabel(data.heat.confidence)} conf
            </span>
          </div>
          <p className="text-sm text-sage-700">{data.heat.body}</p>
          {data.heat.action && (
            <p className="text-xs text-sage-600 italic">→ {data.heat.action}</p>
          )}
        </div>
      )}

      {data.negotiation && (
        <div className="rounded-lg border border-sage-200 bg-warm-white p-3 space-y-1">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <MessageCircle className="w-4 h-4 text-sage-700" />
              <span className="text-sm font-medium text-sage-900">Phase: {data.negotiation.phase_label}</span>
            </div>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${confidenceColor(data.negotiation.confidence)}`}>
              {confidenceLabel(data.negotiation.confidence)} conf
            </span>
          </div>
          <p className="text-sm text-sage-700">{data.negotiation.reasoning}</p>
        </div>
      )}

      {data.decay && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 space-y-1">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <TrendingDown className="w-4 h-4 text-amber-700" />
              <span className="text-sm font-medium text-sage-900">
                Decay: {data.decay.cause_label}
              </span>
              {data.decay.decline_magnitude > 0 && (
                <span className="text-xs text-sage-500">
                  ({data.decay.decline_magnitude}pt drop
                  {data.decay.days_since_last_inbound !== null
                    ? `, ${data.decay.days_since_last_inbound}d silent`
                    : ''})
                </span>
              )}
            </div>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${confidenceColor(data.decay.confidence)}`}>
              {confidenceLabel(data.decay.confidence)} conf
            </span>
          </div>
          <p className="text-sm text-sage-700">{data.decay.reasoning}</p>
          {data.decay.recommendation && (
            <p className="text-xs text-sage-700 italic">→ {data.decay.recommendation}</p>
          )}
          {data.decay.unresolved_questions.length > 0 && (
            <details className="pt-1">
              <summary className="text-xs text-sage-500 cursor-pointer hover:text-sage-700">
                Unresolved question{data.decay.unresolved_questions.length === 1 ? '' : 's'} ({data.decay.unresolved_questions.length})
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-sage-600 list-disc pl-4">
                {data.decay.unresolved_questions.map((q, idx) => (
                  <li key={idx}>{q}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {data.risk && (
        <div className="rounded-lg border border-sage-200 bg-warm-white p-3 space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-sage-700" />
              <span className="text-sm font-medium text-sage-900">
                Risk {data.risk.risk_score}/100
              </span>
              {data.risk.flag_labels.length > 0 && (
                <span className="text-xs text-sage-500">
                  ({data.risk.flag_labels.length} flag{data.risk.flag_labels.length === 1 ? '' : 's'})
                </span>
              )}
            </div>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${confidenceColor(data.risk.confidence)}`}>
              {confidenceLabel(data.risk.confidence)} conf
            </span>
          </div>
          <p className="text-sm text-sage-700">{data.risk.summary}</p>
          {data.risk.action && (
            <p className="text-xs text-sage-600 italic">→ {data.risk.action}</p>
          )}
          {data.risk.flags.length > 0 && (
            <details className="pt-1">
              <summary className="text-xs text-sage-500 cursor-pointer hover:text-sage-700">
                Show evidence
              </summary>
              <ul className="mt-2 space-y-1 text-xs text-sage-600">
                {data.risk.flags.map((f, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className={`inline-flex items-center px-1 py-0.5 rounded text-[9px] font-mono mt-0.5 ${
                      f.severity === 3 ? 'bg-red-100 text-red-800' :
                      f.severity === 2 ? 'bg-amber-100 text-amber-800' :
                      'bg-sage-100 text-sage-700'
                    }`}>
                      sev {f.severity}
                    </span>
                    <span>{f.evidence}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {data.cohort && (
        <div className={`rounded-lg border p-3 space-y-1 ${
          data.cohort.pattern === 'low_converting' ? 'border-amber-200 bg-amber-50/40'
          : data.cohort.pattern === 'high_converting' ? 'border-emerald-200 bg-emerald-50/30'
          : 'border-sage-200 bg-warm-white'
        }`}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              <Users className="w-4 h-4 text-sage-700" />
              <span className="text-sm font-medium text-sage-900">
                Look-alike cohort: {data.cohort.n_booked}/{data.cohort.n_total} booked ({data.cohort.conversion_pct}%)
              </span>
            </div>
            <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${confidenceColor(data.cohort.confidence)}`}>
              {confidenceLabel(data.cohort.confidence)} conf
            </span>
          </div>
          <p className="text-sm text-sage-700">{data.cohort.reasoning}</p>
          {data.cohort.recommendation && (
            <p className="text-xs text-sage-700 italic">→ {data.cohort.recommendation}</p>
          )}
          {/* T5-γ.1: confidence-mix disclosure. Always rendered when
              the backend provides the breakdown so coordinator can
              tell at a glance whether the cohort blends backfilled-low
              members with live ones. Pre-fix the cohort presented as
              a homogeneous group. */}
          {typeof data.cohort.n_high_confidence === 'number' && typeof data.cohort.n_low_confidence === 'number' && (
            <p
              className="text-[11px] text-sage-500 italic"
              title="Provenance breakdown of cohort members. Backfilled-low rows came from Gmail history rather than the live pipeline."
            >
              {data.cohort.n_low_confidence > 0
                ? `Based on ${data.cohort.n_high_confidence} high-fidelity + ${data.cohort.n_low_confidence} backfilled-low cohort member${data.cohort.n_low_confidence === 1 ? '' : 's'}.`
                : `Based on ${data.cohort.n_high_confidence} high-fidelity cohort member${data.cohort.n_high_confidence === 1 ? '' : 's'}.`}
            </p>
          )}
          {(data.cohort.median_booking_value !== null || data.cohort.median_days_to_book !== null) && (
            <div className="flex flex-wrap gap-3 pt-1 text-[11px] text-sage-500">
              {data.cohort.median_booking_value !== null && (
                <span>Median value: ${data.cohort.median_booking_value.toLocaleString()}</span>
              )}
              {data.cohort.median_days_to_book !== null && (
                <span>Median days-to-book: {data.cohort.median_days_to_book}</span>
              )}
            </div>
          )}
        </div>
      )}

      {data.errors.length > 0 && (
        <p className="text-xs text-sage-400 italic">
          ({data.errors.length} insight{data.errors.length === 1 ? '' : 's'} failed to load)
        </p>
      )}
    </div>
  )
}
