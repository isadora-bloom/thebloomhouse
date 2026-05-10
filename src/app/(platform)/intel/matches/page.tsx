'use client'

/**
 * /intel/matches — Wave 5C external-signal matches dashboard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5C external-signal matching)
 *   - bloom-wave4-5-6-master-plan.md (5C spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
 *     evidence quotes are stripped at the cohort layer)
 *
 * Sections per signal type with counts:
 *   Cultural Moments / Vendor Opportunities / Regional Benchmarks /
 *   Competitor Mentions / Cross-Platform Activity.
 *
 * Each match row shows reasoning + evidence + action buttons. Filter
 * controls cycle dismissed/active/actioned views.
 *
 * Sensitivity gating
 * ------------------
 * Same doctrine as Wave 5A/5B. Evidence quotes flagged sensitive=true
 * are not rendered in plaintext — they show "[redacted: sensitive]"
 * instead. Per-couple deep view (lead detail) handles reveal logic.
 */

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Sparkles,
  RefreshCw,
  Loader2,
  AlertCircle,
  Star,
  Building2,
  Globe,
  Users,
  Share2,
  CheckCheck,
  X as XIcon,
  ShieldAlert,
  Send,
  Megaphone,
  Eye,
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

interface ListResponse {
  ok: boolean
  count?: number
  matches?: IntelMatchRow[]
  error?: string
}

type FilterMode = 'active' | 'dismissed' | 'actioned'

const SIGNAL_ORDER: IntelSignalType[] = [
  'cultural_moment',
  'vendor_mention',
  'regional_benchmark',
  'competitor_mention',
  'cross_platform_handle',
]

const SIGNAL_TITLES: Record<IntelSignalType, string> = {
  cultural_moment: 'Cultural moments',
  vendor_mention: 'Vendor opportunities',
  regional_benchmark: 'Regional benchmarks',
  competitor_mention: 'Competitor mentions',
  cross_platform_handle: 'Cross-platform activity',
}

const SIGNAL_DESCRIPTIONS: Record<IntelSignalType, string> = {
  cultural_moment:
    'Confirmed cultural moments scored against your cohort persona distribution.',
  vendor_mention:
    'Vendors mentioned by 3+ couples in their forensic profile — relationship opportunities.',
  regional_benchmark:
    'How your cohort persona distribution compares with the cross-venue average.',
  competitor_mention:
    'Inbound mail referencing competing venues — actively-comparing couples.',
  cross_platform_handle:
    'Couple handles surfaced from identity reconstruction. Tenant 2 review-anchor candidates.',
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
  if (type === 'cultural_moment') return <Star className="w-4 h-4 text-amber-500" />
  if (type === 'vendor_mention') return <Building2 className="w-4 h-4 text-sage-500" />
  if (type === 'regional_benchmark') return <Globe className="w-4 h-4 text-teal-500" />
  if (type === 'competitor_mention') return <Users className="w-4 h-4 text-rose-500" />
  return <Share2 className="w-4 h-4 text-blue-500" />
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
    const t = String(payload.vendor_type ?? '')
    return `${name}${t ? ` (${t})` : ''} — ${n} couple${n === 1 ? '' : 's'}`
  }
  if (type === 'regional_benchmark') {
    return 'Persona distribution vs cross-venue average'
  }
  if (type === 'competitor_mention') {
    return `${String(payload.competitor_name ?? 'competitor')} — ${Number(payload.mention_count ?? 0)} mentions`
  }
  if (type === 'cross_platform_handle') {
    return `${String(payload.platform ?? 'platform')} — ${String(payload.handle ?? '')}`
  }
  return SIGNAL_TITLES[type]
}

function visibleQuote(q: EvidenceQuote): string {
  if (q.sensitive) return '[redacted: sensitive — see lead detail]'
  return q.quote
}

export default function IntelMatchesDashboard() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [filter, setFilter] = useState<FilterMode>('active')
  const [busyId, setBusyId] = useState<string | null>(null)

  const fetchList = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '500' })
      if (filter === 'active') {
        params.set('dismissed', 'false')
        params.set('actioned', 'false')
      } else if (filter === 'dismissed') {
        params.set('dismissed', 'true')
      } else if (filter === 'actioned') {
        params.set('actioned', 'true')
      }
      const res = await fetch(
        `/api/admin/intel/external-matches/list?${params.toString()}`,
        { cache: 'no-store' },
      )
      const body = (await res.json()) as ListResponse
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
  }, [filter])

  useEffect(() => {
    setLoading(true)
    fetchList().finally(() => setLoading(false))
  }, [fetchList])

  const grouped = useMemo(() => {
    const out: Record<IntelSignalType, IntelMatchRow[]> = {
      cultural_moment: [],
      vendor_mention: [],
      regional_benchmark: [],
      competitor_mention: [],
      cross_platform_handle: [],
    }
    for (const m of data?.matches ?? []) {
      out[m.signal_type].push(m)
    }
    return out
  }, [data])

  async function runScan() {
    setScanning(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/external-matches/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      await fetchList()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(msg)
    } finally {
      setScanning(false)
    }
  }

  async function refreshList() {
    setRefreshing(true)
    try {
      await fetchList()
    } finally {
      setRefreshing(false)
    }
  }

  async function dismiss(matchId: string) {
    setBusyId(matchId)
    try {
      const res = await fetch('/api/admin/intel/external-matches/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ matchId, reason: 'dismissed_from_dashboard' }),
      })
      if (res.ok) {
        await fetchList()
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
        await fetchList()
      }
    } finally {
      setBusyId(null)
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

  const matches = data?.matches ?? []
  const counts = SIGNAL_ORDER.reduce(
    (acc, t) => {
      acc[t] = grouped[t].length
      return acc
    },
    {} as Record<IntelSignalType, number>,
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            External signal matches
          </h1>
          <p className="text-sm text-sage-600 mt-1">
            Cultural moments, vendor opportunities, regional benchmarks,
            competitor mentions, and cross-platform handles — scored against
            your cohort.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runScan}
            disabled={scanning}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-sage-600 text-white rounded-md hover:bg-sage-700 disabled:opacity-50"
          >
            {scanning ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {scanning ? 'Scanning...' : 'Run new scan'}
          </button>
          <button
            type="button"
            onClick={refreshList}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs border border-sage-300 text-sage-700 rounded-md hover:bg-sage-50 disabled:opacity-50"
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

      {/* Filter pills + counts strip */}
      <div className="bg-surface border border-border rounded-xl p-4 shadow-sm flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          {(['active', 'actioned', 'dismissed'] as FilterMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setFilter(m)}
              className={`px-3 py-1 text-xs rounded-md ${
                filter === m
                  ? 'bg-sage-600 text-white'
                  : 'bg-sage-50 text-sage-700 hover:bg-sage-100'
              }`}
            >
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-3 text-xs text-sage-500 flex-wrap">
          {SIGNAL_ORDER.map((t) => (
            <span key={t} className="inline-flex items-center gap-1">
              {signalIcon(t)}
              <span className="font-medium text-sage-700">{counts[t]}</span>
              <span className="text-sage-500">{SIGNAL_TITLES[t].toLowerCase()}</span>
            </span>
          ))}
          <span className="ml-auto text-sage-400">{matches.length} total</span>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-2 text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {SIGNAL_ORDER.map((type) => {
        const rows = grouped[type]
        return (
          <section
            key={type}
            className="bg-surface border border-border rounded-xl shadow-sm"
          >
            <div className="px-6 py-4 border-b border-border flex items-center gap-2">
              {signalIcon(type)}
              <h2 className="font-heading text-base font-semibold text-sage-900">
                {SIGNAL_TITLES[type]}
              </h2>
              <span className="text-xs text-sage-500 ml-auto">
                {rows.length} surfaced
              </span>
            </div>
            {rows.length === 0 ? (
              <div className="px-6 py-6 text-sm text-sage-500">
                <p>No active matches in this category.</p>
                <p className="text-xs mt-1 text-sage-400">
                  {SIGNAL_DESCRIPTIONS[type]}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {rows.map((m) => {
                  const evidence = m.evidence_quotes ?? []
                  return (
                    <li key={m.id} className="px-6 py-4">
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5">{signalIcon(m.signal_type)}</div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline flex-wrap gap-2">
                            <span className="font-medium text-sage-900">
                              {summarisePayload(m.signal_type, m.signal_payload)}
                            </span>
                            <span className="text-[11px] text-sage-500">
                              conf {m.match_confidence_0_100}
                              {m.cohort_fit_score_0_100 !== null && (
                                <> · cohort fit {m.cohort_fit_score_0_100}</>
                              )}
                            </span>
                            {m.wedding_id && (
                              <span className="text-[10px] text-blue-600 bg-blue-50 border border-blue-100 px-1.5 py-0.5 rounded">
                                per-couple
                              </span>
                            )}
                            {m.actioned_at && (
                              <span className="text-[10px] text-emerald-700 bg-emerald-50 border border-emerald-100 px-1.5 py-0.5 rounded">
                                actioned: {m.action_taken}
                              </span>
                            )}
                            {m.dismissed_at && (
                              <span className="text-[10px] text-rose-700 bg-rose-50 border border-rose-100 px-1.5 py-0.5 rounded">
                                dismissed
                              </span>
                            )}
                          </div>
                          {m.match_reasoning && (
                            <p className="text-sm text-sage-700 leading-snug mt-1">
                              {m.match_reasoning}
                            </p>
                          )}
                          {evidence.length > 0 && (
                            <ul className="mt-2 space-y-1">
                              {evidence.slice(0, 3).map((q, i) => (
                                <li
                                  key={i}
                                  className={`text-xs leading-snug italic ${
                                    q.sensitive ? 'text-rose-600' : 'text-sage-500'
                                  }`}
                                >
                                  {q.sensitive && (
                                    <ShieldAlert className="inline w-3 h-3 mr-1" />
                                  )}
                                  &ldquo;{visibleQuote(q)}&rdquo;
                                  <span className="text-[10px] text-sage-400 ml-2">
                                    {q.source}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          )}
                          <div className="text-[11px] text-sage-400 mt-2">
                            {relativeTime(m.fired_at)}
                          </div>
                        </div>
                        {!m.dismissed_at && !m.actioned_at && (
                          <div className="flex flex-col items-end gap-1.5">
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => action(m.id, 'sent_to_couple')}
                                disabled={busyId === m.id}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
                                title="Send to couple"
                              >
                                <Send className="w-3 h-3" />
                                Send
                              </button>
                              <button
                                type="button"
                                onClick={() => action(m.id, 'added_to_marketing')}
                                disabled={busyId === m.id}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
                                title="Add to marketing"
                              >
                                <Megaphone className="w-3 h-3" />
                                Marketing
                              </button>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => action(m.id, 'investigated')}
                                disabled={busyId === m.id}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
                                title="Mark investigated"
                              >
                                <Eye className="w-3 h-3" />
                                Investigated
                              </button>
                              <button
                                type="button"
                                onClick={() => action(m.id, 'shared_with_team')}
                                disabled={busyId === m.id}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
                                title="Share with team"
                              >
                                <CheckCheck className="w-3 h-3" />
                                Share
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
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}

      <div className="text-[10px] text-sage-400 font-mono text-center pt-4">
        external-match.prompt.v1
      </div>
    </div>
  )
}
