'use client'

import { useState, useEffect, useCallback } from 'react'
import { Flame, MessageCircle, AlertTriangle, TrendingDown, RefreshCw, Loader2 } from 'lucide-react'

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

interface InsightsResponse {
  weddingId: string
  venueId: string
  status: string
  heat: HeatInsight | null
  negotiation: NegotiationInsight | null
  risk: RiskInsight | null
  decay: DecayInsight | null
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
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchInsights = useCallback(async (refresh: boolean = false) => {
    if (refresh) setRefreshing(true)
    else setLoading(true)
    try {
      const url = `/api/insights/lead/${weddingId}${refresh ? '?refresh=1' : ''}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as InsightsResponse
      setData(json)
      setError(null)
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
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-sage-900 text-sm">Lead insights</h3>
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

      {data.errors.length > 0 && (
        <p className="text-xs text-sage-400 italic">
          ({data.errors.length} insight{data.errors.length === 1 ? '' : 's'} failed to load)
        </p>
      )}
    </div>
  )
}
