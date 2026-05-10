'use client'

/**
 * IntelMatchesPanel — Wave 5C embeddable preview panel.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5C external-signal matching)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5C spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
 *     evidence quotes are stripped at the cohort layer)
 *
 * Why a separate panel from the dashboard
 * ---------------------------------------
 * The /intel landing surface needs a top-5 active-matches widget —
 * coordinators see "what external signals matched my cohort this week"
 * without leaving their existing flow. Full triage happens on the
 * dedicated dashboard at /intel/matches.
 *
 * Sensitivity gating
 * ------------------
 * Same doctrine as Wave 5A/5B. Evidence quotes flagged sensitive=true
 * are not rendered in plaintext — they show a "[redacted: sensitive]"
 * badge instead. Coordinators with the reveal feature flag see the
 * quote on the lead-detail panel, not here.
 */

import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Sparkles,
  CheckCheck,
  X as XIcon,
  ArrowUpRight,
  Loader2,
  AlertCircle,
  ShieldAlert,
  Star,
  Globe,
  Users,
  Building2,
  Share2,
} from 'lucide-react'

interface EvidenceQuote {
  quote: string
  source: string
  source_id?: string | null
  sensitive?: boolean
}

type IntelSignalType =
  | 'cultural_moment'
  | 'vendor_mention'
  | 'regional_benchmark'
  | 'competitor_mention'
  | 'cross_platform_handle'

interface IntelMatchRow {
  id: string
  venue_id: string
  wedding_id: string | null
  signal_type: IntelSignalType
  signal_payload: Record<string, unknown>
  match_reasoning: string | null
  match_confidence_0_100: number
  cohort_fit_score_0_100: number | null
  evidence_quotes: EvidenceQuote[] | null
  fired_at: string
  dismissed_at: string | null
  actioned_at: string | null
  action_taken: string | null
}

interface PanelResponse {
  ok: boolean
  count?: number
  matches?: IntelMatchRow[]
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

function signalIcon(type: IntelSignalType) {
  if (type === 'cultural_moment') return <Star className="w-3.5 h-3.5 text-amber-500" />
  if (type === 'vendor_mention') return <Building2 className="w-3.5 h-3.5 text-sage-500" />
  if (type === 'regional_benchmark') return <Globe className="w-3.5 h-3.5 text-teal-500" />
  if (type === 'competitor_mention') return <Users className="w-3.5 h-3.5 text-rose-500" />
  return <Share2 className="w-3.5 h-3.5 text-blue-500" />
}

function signalLabel(type: IntelSignalType): string {
  return {
    cultural_moment: 'Cultural moment',
    vendor_mention: 'Vendor mention',
    regional_benchmark: 'Regional benchmark',
    competitor_mention: 'Competitor mention',
    cross_platform_handle: 'Cross-platform handle',
  }[type]
}

function summarisePayload(
  type: IntelSignalType,
  payload: Record<string, unknown>,
): string {
  if (type === 'cultural_moment') {
    return String(payload.title ?? 'cultural moment')
  }
  if (type === 'vendor_mention') {
    const name = String(payload.vendor_name ?? 'vendor')
    const n = Number(payload.distinct_couples ?? 0)
    return `${name} (${n} couple${n === 1 ? '' : 's'})`
  }
  if (type === 'regional_benchmark') {
    return 'Cross-venue persona skew'
  }
  if (type === 'competitor_mention') {
    return `${String(payload.competitor_name ?? 'competitor')} (${Number(payload.mention_count ?? 0)} mentions)`
  }
  if (type === 'cross_platform_handle') {
    return `${String(payload.platform ?? 'platform')}: ${String(payload.handle ?? '')}`
  }
  return signalLabel(type)
}

function visibleQuote(q: EvidenceQuote): string {
  if (q.sensitive) return '[redacted: sensitive — see lead detail]'
  return q.quote
}

interface IntelMatchesPanelProps {
  /** Per-couple filter. When set, panel shows only matches for this wedding. */
  weddingId?: string
  /** Embedding label override. */
  title?: string
}

export function IntelMatchesPanel(props: IntelMatchesPanelProps = {}) {
  const [data, setData] = useState<PanelResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const fetchMatches = useCallback(async () => {
    try {
      const params = new URLSearchParams({ dismissed: 'false', limit: '5' })
      if (props.weddingId) params.set('weddingId', props.weddingId)
      const res = await fetch(
        `/api/admin/intel/external-matches/list?${params.toString()}`,
        { cache: 'no-store' },
      )
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
  }, [props.weddingId])

  useEffect(() => {
    setLoading(true)
    fetchMatches().finally(() => setLoading(false))
  }, [fetchMatches])

  async function dismiss(matchId: string) {
    setBusyId(matchId)
    try {
      const res = await fetch('/api/admin/intel/external-matches/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, reason: 'dismissed_from_panel' }),
      })
      if (res.ok) {
        await fetchMatches()
      }
    } finally {
      setBusyId(null)
    }
  }

  async function action(matchId: string, actionTaken: string) {
    setBusyId(matchId)
    try {
      const res = await fetch('/api/admin/intel/external-matches/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, actionTaken }),
      })
      if (res.ok) {
        await fetchMatches()
      }
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            {props.title ?? 'External signal matches'}
          </h2>
          <Loader2 className="w-3.5 h-3.5 ml-auto text-sage-400 animate-spin" />
        </div>
        <div className="p-6 text-sm text-sage-500">Loading matches...</div>
      </div>
    )
  }

  const matches = data?.matches ?? []

  if (matches.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-xl shadow-sm">
        <div className="px-6 py-4 border-b border-border flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-sage-500" />
          <h2 className="font-heading text-base font-semibold text-sage-900">
            {props.title ?? 'External signal matches'}
          </h2>
          <Link
            href="/intel/matches"
            className="ml-auto inline-flex items-center gap-1 text-xs text-sage-700 hover:text-sage-900 hover:underline"
          >
            Full dashboard
            <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        <div className="p-6 text-sm text-sage-500">
          {error
            ? `Failed to load matches: ${error}`
            : 'No active matches yet. Run a scan to surface signals.'}
        </div>
      </div>
    )
  }

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-border flex items-center gap-2">
        <Sparkles className="w-4 h-4 text-sage-500" />
        <h2 className="font-heading text-base font-semibold text-sage-900">
          {props.title ?? 'External signal matches'}
        </h2>
        <span className="text-xs text-sage-500">
          {matches.length} active
        </span>
        <Link
          href="/intel/matches"
          className="ml-auto inline-flex items-center gap-1 text-xs text-sage-700 hover:text-sage-900 hover:underline"
        >
          Full dashboard
          <ArrowUpRight className="w-3 h-3" />
        </Link>
      </div>

      <ul className="divide-y divide-border">
        {matches.map((m) => {
          const evidence = (m.evidence_quotes ?? []).slice(0, 1)
          return (
            <li key={m.id} className="px-6 py-3">
              <div className="flex items-start gap-3">
                <div className="mt-0.5">{signalIcon(m.signal_type)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline flex-wrap gap-2">
                    <span className="text-[10px] uppercase tracking-wide text-sage-500">
                      {signalLabel(m.signal_type)}
                    </span>
                    <span className="font-medium text-sage-900 text-sm">
                      {summarisePayload(m.signal_type, m.signal_payload)}
                    </span>
                    <span className="text-[10px] text-sage-500">
                      conf {m.match_confidence_0_100}
                      {m.cohort_fit_score_0_100 !== null && (
                        <> · fit {m.cohort_fit_score_0_100}</>
                      )}
                    </span>
                  </div>
                  {m.match_reasoning && (
                    <p className="text-xs text-sage-700 leading-snug mt-0.5">
                      {m.match_reasoning}
                    </p>
                  )}
                  {evidence.map((q, i) => (
                    <p
                      key={i}
                      className={`text-[11px] leading-snug mt-1 italic ${
                        q.sensitive ? 'text-rose-600' : 'text-sage-500'
                      }`}
                    >
                      {q.sensitive && (
                        <ShieldAlert className="inline w-3 h-3 mr-1" />
                      )}
                      &ldquo;{visibleQuote(q)}&rdquo;
                    </p>
                  ))}
                  <div className="text-[10px] text-sage-400 mt-1 flex items-center gap-2">
                    <span>{relativeTime(m.fired_at)}</span>
                    {m.actioned_at && (
                      <span className="text-emerald-600">
                        actioned: {m.action_taken}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => action(m.id, 'investigated')}
                    disabled={busyId === m.id}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
                    title="Mark as investigated"
                  >
                    <CheckCheck className="w-3 h-3" />
                    Action
                  </button>
                  <button
                    type="button"
                    onClick={() => dismiss(m.id)}
                    disabled={busyId === m.id}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-200 text-sage-600 rounded hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                    title="Dismiss"
                  >
                    <XIcon className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      {error && (
        <div className="px-6 py-2 text-xs text-rose-600 border-t border-rose-100 bg-rose-50/40 flex items-center gap-1">
          <AlertCircle className="w-3 h-3" /> {error}
        </div>
      )}
    </div>
  )
}
