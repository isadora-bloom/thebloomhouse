'use client'

/**
 * CoupleIntelPanel — Wave 5A read surface for couple_intel.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; Wave 5A is the action layer derived from the forensic
 *     record)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5A spec: persona +
 *     close-prob + recommended action + coordinator brief +
 *     sensitivity flags + stale-signal alerts)
 *
 * Sensitivity gating
 * ------------------
 * sensitivity_flags carry category + handle_with coaching. NEVER an
 * evidence_quote. The synthesizer prompt (couple-intel-derive.ts)
 * enforces voice-shape only — handle_with is coaching ("let them lead
 * the pace"), not the raw quote. So unlike the
 * ReconstructedIdentityPanel, this panel has no gating problem; the
 * raw quotes live in couple_identity_profile and are gated there. We
 * still respect venue_config.feature_flags.reveal_sensitive_themes
 * for the optional reveal of additional context.
 *
 * Empty state
 * -----------
 * When the intel row does not yet exist, the panel renders
 * "Intel pending — queued for background processing" plus a manual
 * "Derive now" button that POSTs to /api/admin/intel/couple-derive.
 *
 * Footer
 * ------
 * "Last derived N ago" + a "Refresh" button (force=true).
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Sparkles,
  RefreshCw,
  AlertCircle,
  Loader2,
  Target,
  Clock,
  Brain,
  ShieldAlert,
  Bell,
  Lightbulb,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { WhyThisCard } from '@/components/ui/why-this-card'

interface PredictedCloseProbability {
  pct_0_100: number
  reasoning: string
  key_signals: string[]
  confidence_0_100: number
}

interface PersonaBlock {
  label: string
  description: string
  confidence_0_100: number
}

interface RecommendedNextAction {
  action: string
  timing: string
  reasoning: string
}

interface SensitivityFlag {
  category: string
  handle_with: string
}

interface StaleSignalAlert {
  signal: string
  since: string
  suggested_action: string
}

interface CoupleIntelOutput {
  predicted_close_probability: PredictedCloseProbability
  persona: PersonaBlock
  recommended_next_action: RecommendedNextAction
  coordinator_brief: string
  sensitivity_flags: SensitivityFlag[]
  stale_signal_alerts: StaleSignalAlert[]
  refusals: Array<{ field: string; reason: string }>
}

interface IntelResponse {
  ok: boolean
  weddingId?: string
  venueId?: string
  intel?: CoupleIntelOutput
  predictedCloseProbabilityPct?: number | null
  personaLabel?: string | null
  promptVersion?: string
  deriveCount?: number
  lastDerivedAt?: string
  sourceProfileAt?: string | null
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

function closeProbColor(pct: number): {
  bar: string
  pill: string
  pillText: string
} {
  if (pct >= 75) {
    return { bar: 'bg-emerald-500', pill: 'bg-emerald-50 border-emerald-200', pillText: 'text-emerald-700' }
  }
  if (pct >= 50) {
    return { bar: 'bg-blue-500', pill: 'bg-blue-50 border-blue-200', pillText: 'text-blue-700' }
  }
  if (pct >= 25) {
    return { bar: 'bg-amber-500', pill: 'bg-amber-50 border-amber-200', pillText: 'text-amber-700' }
  }
  return { bar: 'bg-rose-500', pill: 'bg-rose-50 border-rose-200', pillText: 'text-rose-700' }
}

export function CoupleIntelPanel({ weddingId }: { weddingId: string }) {
  const [data, setData] = useState<IntelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const fetchIntel = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/intel/couple-derive?weddingId=${encodeURIComponent(weddingId)}`,
        { cache: 'no-store' },
      )
      if (res.status === 404) {
        // No intel row yet — empty state.
        setData({ ok: false, error: 'no-intel' })
        setError(null)
        return
      }
      const body = (await res.json()) as IntelResponse
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
  }, [weddingId])

  useEffect(() => {
    setLoading(true)
    fetchIntel().finally(() => setLoading(false))
  }, [fetchIntel])

  async function refresh(force: boolean) {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/couple-derive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weddingId, force }),
      })
      const body = (await res.json()) as IntelResponse
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

  // ---- Loading -----------------------------------------------------
  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Couple intelligence
          </h2>
          <Loader2 className="w-3.5 h-3.5 ml-auto text-sage-400 animate-spin" />
        </div>
        <div className="p-6 text-sm text-sage-500">Loading derived intel...</div>
      </div>
    )
  }

  // ---- Empty (intel row missing) ----------------------------------
  if (!data || (!data.intel && data.error === 'no-intel')) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            Couple intelligence
          </h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-sage-600 mb-3">
            Intel pending — queued for background processing.
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
            {refreshing ? 'Deriving...' : 'Derive now'}
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

  // ---- Error (intel load failed) ----------------------------------
  if (error && !data.intel) {
    return (
      <div className="bg-surface border border-rose-200 rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <AlertCircle className="w-4 h-4 text-rose-500" />
          <h2 className="font-heading text-base font-semibold text-rose-700">
            Couple intelligence — failed to load
          </h2>
        </div>
        <div className="p-6">
          <p className="text-sm text-rose-700">{error}</p>
        </div>
      </div>
    )
  }

  const intel = data.intel!
  const pct = intel.predicted_close_probability.pct_0_100
  const closeColors = closeProbColor(pct)

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      {/* Header — persona + close-prob + last derived + refresh */}
      <div className="px-6 py-4 border-b border-border flex items-center gap-3 flex-wrap">
        <Sparkles className="w-4 h-4 text-sage-500" />
        <h2 className="font-heading text-base font-semibold text-sage-900">
          Couple intelligence
        </h2>

        {/* Persona pill */}
        <span
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-sage-50 border border-sage-200 text-sage-800"
          title={intel.persona.description}
        >
          <Brain className="w-3 h-3" />
          {intel.persona.label}
          <span className="text-[10px] text-sage-500 font-normal">
            {intel.persona.confidence_0_100}%
          </span>
        </span>

        {/* Close-prob bar + pill */}
        <div className="flex items-center gap-2 ml-auto">
          <span
            className={cn(
              'inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium border',
              closeColors.pill,
              closeColors.pillText,
            )}
            title={intel.predicted_close_probability.reasoning}
          >
            <Target className="w-3 h-3" />
            {pct}% close-prob
            <span className="text-[10px] opacity-70">
              · {intel.predicted_close_probability.confidence_0_100}% conf
            </span>
          </span>
          <div
            className="w-24 h-1.5 bg-sage-100 rounded-full overflow-hidden hidden md:block"
            title={`${pct}% predicted close probability`}
          >
            <div
              className={cn('h-full rounded-full transition-all', closeColors.bar)}
              style={{ width: `${Math.min(pct, 100)}%` }}
            />
          </div>
        </div>
      </div>

      {/* Coordinator brief — top-of-panel emphasis */}
      <div className="px-6 py-4 border-b border-border bg-sage-50/40">
        <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide font-semibold text-sage-700">
          <Lightbulb className="w-3.5 h-3.5" />
          Coordinator brief
        </div>
        <p className="text-sm text-sage-800 leading-relaxed whitespace-pre-wrap">
          {intel.coordinator_brief}
        </p>
      </div>

      {/* Recommended next action */}
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide font-semibold text-sage-700">
          <Clock className="w-3.5 h-3.5" />
          Recommended next action
        </div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <p className="text-sm font-medium text-sage-900">
            {intel.recommended_next_action.action}
          </p>
          <span className="text-xs text-sage-600 italic">
            {intel.recommended_next_action.timing}
          </span>
        </div>
        <WhyThisCard
          className="mt-2"
          title="Why this action, why now"
          reasoning={[
            intel.recommended_next_action.reasoning,
            intel.predicted_close_probability.reasoning
              ? `Close-probability rationale: ${intel.predicted_close_probability.reasoning}`
              : null,
          ]
            .filter(Boolean)
            .join('\n\n')}
          evidence={intel.predicted_close_probability.key_signals}
        />
      </div>

      {/* Sensitivity flags — chips. handle_with is coaching, never raw quote. */}
      {intel.sensitivity_flags.length > 0 && (
        <div className="px-6 py-3 border-b border-border">
          <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide font-semibold text-sage-700">
            <ShieldAlert className="w-3.5 h-3.5 text-rose-500" />
            Sensitivity flags
          </div>
          <div className="flex flex-wrap gap-2">
            {intel.sensitivity_flags.map((flag, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium bg-rose-50 border border-rose-100 text-rose-700"
                title={flag.handle_with}
              >
                {flag.category}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[10px] text-sage-500 italic">
            Hover a flag for handling guidance. Raw evidence quotes stay in the
            forensic record below.
          </p>
        </div>
      )}

      {/* Stale signal alerts */}
      {intel.stale_signal_alerts.length > 0 && (
        <div className="px-6 py-3 border-b border-border">
          <div className="flex items-center gap-2 mb-2 text-xs uppercase tracking-wide font-semibold text-sage-700">
            <Bell className="w-3.5 h-3.5 text-amber-500" />
            Stale-signal alerts
          </div>
          <ul className="space-y-2">
            {intel.stale_signal_alerts.map((alert, i) => (
              <li
                key={i}
                className="text-sm text-sage-800 leading-snug border-l-2 border-amber-200 pl-3"
              >
                <div className="font-medium">{alert.signal}</div>
                <div className="text-xs text-sage-500 mt-0.5">
                  Since: {alert.since}
                </div>
                <div className="text-xs text-sage-700 mt-0.5 italic">
                  → {alert.suggested_action}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Footer — last derived + refresh */}
      <div className="px-6 py-3 bg-sage-50/30 flex items-center gap-3 text-[11px] text-sage-500">
        <span>Last derived {relativeTime(data.lastDerivedAt)}</span>
        {typeof data.deriveCount === 'number' && (
          <span>· {data.deriveCount} run{data.deriveCount === 1 ? '' : 's'}</span>
        )}
        {data.promptVersion && (
          <span className="font-mono text-sage-400">{data.promptVersion}</span>
        )}
        <button
          type="button"
          onClick={() => refresh(true)}
          disabled={refreshing}
          className="ml-auto inline-flex items-center gap-1.5 px-2 py-1 text-[11px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
          title="Force a fresh Sonnet derive. Use when new signals have landed since the last run."
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
