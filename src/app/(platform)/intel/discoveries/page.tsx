'use client'

/**
 * /intel/discoveries — Wave 7A pattern discovery dashboard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7 closes the forensic loop. THE
 *     differentiator vs every other CRM — this surface tells the operator
 *     what they DON'T know).
 *   - bloom-wave4-5-6-master-plan.md (Wave 7A spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose; evidence is
 *     anonymised aggregates only)
 *
 * Layout
 * ------
 * Top of page: empty state + "Run discovery engine now" button.
 * Sections by validation_status: Pending / In progress / Validated /
 * Refuted / Dismissed.
 * Within Pending, group visually by hypothesis_category for fast scan.
 * Each discovery card: title (prominent), text, category badge,
 * confidence pill, evidence summary collapsed, recommended test, action
 * row (validate / dismiss / mark actioned).
 */

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Sparkles,
  RefreshCw,
  Loader2,
  AlertCircle,
  ShieldAlert,
  X as XIcon,
  CheckCheck,
  FlaskConical,
  ChevronDown,
  ChevronUp,
  Lightbulb,
} from 'lucide-react'

interface DiscoveryRow {
  id: string
  venue_id: string
  hypothesis_title: string
  hypothesis_text: string
  hypothesis_category: string
  evidence_summary: {
    signal_type?: string
    n_couples?: number
    n_evidence_points?: number
    aggregate_stats?: Record<string, unknown>
    key_observations?: string[]
  } | null
  recommended_test: string | null
  recommended_action_if_validated: string | null
  confidence_0_100: number
  validation_status: string
  validation_result_summary: string | null
  validation_metric: Record<string, unknown> | null
  validated_at: string | null
  dismissed_at: string | null
  dismissed_by: string | null
  dismissal_reason: string | null
  actioned_at: string | null
  action_taken: string | null
  prompt_version: string
  cost_cents: number
  created_at: string
  updated_at: string
}

interface ListResponse {
  ok: boolean
  count?: number
  discoveries?: DiscoveryRow[]
  error?: string
}

const STATUS_ORDER = [
  'pending',
  'in_progress',
  'validated',
  'refuted',
  'dismissed',
] as const
type StatusKey = (typeof STATUS_ORDER)[number]

const STATUS_TITLES: Record<StatusKey, string> = {
  pending: 'Pending — awaiting review',
  in_progress: 'In progress — test running',
  validated: 'Validated',
  refuted: 'Refuted',
  dismissed: 'Dismissed',
}

const STATUS_DESCRIPTIONS: Record<StatusKey, string> = {
  pending:
    'Hypotheses the engine surfaced this week. Read the evidence, then decide whether to test, action, or dismiss.',
  in_progress: 'Wave 7C is running the recommended test. Result lands here when complete.',
  validated:
    'The test confirmed this pattern. Action is recommended; promotion into a Wave 5/6 bucket is queued for Wave 7D.',
  refuted: 'The test ran but did not confirm. Kept for audit; safe to ignore.',
  dismissed:
    'Coordinator dismissed without testing. Audit trail preserved.',
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

function confidenceColor(conf: number): string {
  if (conf >= 80) return 'bg-emerald-50 text-emerald-700 border-emerald-200'
  if (conf >= 60) return 'bg-amber-50 text-amber-700 border-amber-200'
  if (conf >= 40) return 'bg-sage-50 text-sage-700 border-sage-200'
  return 'bg-slate-50 text-slate-600 border-slate-200'
}

function categoryColor(category: string): string {
  // Hash the category to a stable colour. Wave 7A's categories are
  // free-form so we cannot enumerate them; use a CSS-friendly palette
  // chosen by string hash.
  const palette = [
    'bg-rose-50 text-rose-700 border-rose-200',
    'bg-teal-50 text-teal-700 border-teal-200',
    'bg-amber-50 text-amber-700 border-amber-200',
    'bg-blue-50 text-blue-700 border-blue-200',
    'bg-purple-50 text-purple-700 border-purple-200',
    'bg-emerald-50 text-emerald-700 border-emerald-200',
    'bg-cyan-50 text-cyan-700 border-cyan-200',
    'bg-pink-50 text-pink-700 border-pink-200',
  ]
  let h = 0
  for (let i = 0; i < category.length; i++) {
    h = (h * 31 + category.charCodeAt(i)) | 0
  }
  return palette[Math.abs(h) % palette.length]
}

function humaniseCategory(category: string): string {
  return category
    .split('_')
    .map((s) => (s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1)))
    .join(' ')
}

function DiscoveryCard({
  d,
  busy,
  onAction,
  onDismiss,
}: {
  d: DiscoveryRow
  busy: boolean
  onAction: (id: string, actionTaken: string) => void
  onDismiss: (id: string, reason: string) => void
}) {
  const [evidenceOpen, setEvidenceOpen] = useState(false)
  const evidence = d.evidence_summary
  const observations = evidence?.key_observations ?? []
  const stats = evidence?.aggregate_stats ?? {}
  const statKeys = Object.keys(stats)
  const isPending = d.validation_status === 'pending'

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-6 py-4 border-b border-border">
        <div className="flex items-start gap-3 flex-wrap">
          <div className="flex-1 min-w-[280px]">
            <h3 className="font-heading text-base font-semibold text-sage-900">
              {d.hypothesis_title}
            </h3>
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              <span
                className={`text-[11px] px-2 py-0.5 rounded border ${categoryColor(d.hypothesis_category)}`}
                title={d.hypothesis_category}
              >
                {humaniseCategory(d.hypothesis_category)}
              </span>
              <span
                className={`text-[11px] px-2 py-0.5 rounded border ${confidenceColor(d.confidence_0_100)}`}
              >
                confidence {d.confidence_0_100}
              </span>
              {d.validation_status === 'validated' && (
                <span className="text-[11px] px-2 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200">
                  validated {relativeTime(d.validated_at)}
                </span>
              )}
              {d.validation_status === 'refuted' && (
                <span className="text-[11px] px-2 py-0.5 rounded border bg-rose-50 text-rose-700 border-rose-200">
                  refuted
                </span>
              )}
              {d.actioned_at && (
                <span className="text-[11px] px-2 py-0.5 rounded border bg-emerald-50 text-emerald-700 border-emerald-200">
                  actioned: {d.action_taken}
                </span>
              )}
              {d.dismissed_at && (
                <span className="text-[11px] px-2 py-0.5 rounded border bg-slate-50 text-slate-600 border-slate-200">
                  dismissed
                </span>
              )}
              <span className="text-[10px] text-sage-400">
                {relativeTime(d.created_at)}
              </span>
            </div>
          </div>
          {isPending && (
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => onAction(d.id, 'tested')}
                  disabled={busy}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
                  title="Mark a test was run by Wave 7C or manually"
                >
                  <FlaskConical className="w-3 h-3" />
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => onAction(d.id, 'rolled_into_strategy')}
                  disabled={busy}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-300 text-sage-700 rounded hover:bg-sage-50 disabled:opacity-50"
                  title="Coordinator acted on this without a formal test"
                >
                  <CheckCheck className="w-3 h-3" />
                  Actioned
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onDismiss(d.id, 'dismissed_from_dashboard')
                  }
                  disabled={busy}
                  className="inline-flex items-center gap-1 px-2 py-1 text-[10px] border border-sage-200 text-sage-600 rounded hover:bg-rose-50 hover:text-rose-700 disabled:opacity-50"
                  title="Dismiss"
                >
                  <XIcon className="w-3 h-3" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="px-6 py-4 space-y-4">
        <p className="text-sm text-sage-800 leading-relaxed">
          {d.hypothesis_text}
        </p>

        {(observations.length > 0 ||
          statKeys.length > 0 ||
          evidence?.signal_type) && (
          <div className="border border-border rounded-lg">
            <button
              type="button"
              onClick={() => setEvidenceOpen((v) => !v)}
              className="w-full px-4 py-2 flex items-center justify-between text-xs text-sage-600 hover:bg-sage-50/50"
            >
              <span className="inline-flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 text-sage-500" />
                Evidence summary
                {evidence?.n_couples ? (
                  <span className="text-sage-400">
                    · n={evidence.n_couples}
                    {evidence?.n_evidence_points
                      ? ` · ${evidence.n_evidence_points} evidence points`
                      : ''}
                  </span>
                ) : null}
              </span>
              {evidenceOpen ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
            {evidenceOpen && (
              <div className="px-4 pb-3 pt-1 space-y-2 text-xs text-sage-700">
                {evidence?.signal_type && (
                  <div className="text-[11px] text-sage-500">
                    signal_type: <code>{evidence.signal_type}</code>
                  </div>
                )}
                {observations.length > 0 && (
                  <ul className="list-disc pl-4 space-y-0.5">
                    {observations.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                )}
                {statKeys.length > 0 && (
                  <div className="bg-sage-50/50 rounded px-2 py-1.5 text-[11px] font-mono text-sage-600 overflow-x-auto">
                    {statKeys.map((k) => (
                      <div key={k}>
                        <span className="text-sage-500">{k}:</span>{' '}
                        {JSON.stringify(stats[k])}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {d.recommended_test && (
          <div className="bg-amber-50/40 border border-amber-100 rounded-lg px-4 py-3">
            <div className="text-[11px] font-medium text-amber-800 uppercase tracking-wide mb-1">
              Recommended test (Wave 7C)
            </div>
            <p className="text-xs text-amber-900 leading-snug">
              {d.recommended_test}
            </p>
          </div>
        )}

        {d.recommended_action_if_validated && (
          <div className="bg-emerald-50/40 border border-emerald-100 rounded-lg px-4 py-3">
            <div className="text-[11px] font-medium text-emerald-800 uppercase tracking-wide mb-1">
              Recommended action (if validated)
            </div>
            <p className="text-xs text-emerald-900 leading-snug">
              {d.recommended_action_if_validated}
            </p>
          </div>
        )}

        {d.validation_result_summary && (
          <div className="bg-blue-50/40 border border-blue-100 rounded-lg px-4 py-3">
            <div className="text-[11px] font-medium text-blue-800 uppercase tracking-wide mb-1">
              Validation result
            </div>
            <p className="text-xs text-blue-900 leading-snug">
              {d.validation_result_summary}
            </p>
          </div>
        )}

        {d.dismissal_reason && (
          <div className="text-[11px] text-sage-500 italic">
            Dismissed: {d.dismissal_reason}
          </div>
        )}
      </div>
    </div>
  )
}

export default function DiscoveriesDashboard() {
  const [data, setData] = useState<ListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [running, setRunning] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [runStatus, setRunStatus] = useState<string | null>(null)

  const fetchList = useCallback(async () => {
    try {
      const params = new URLSearchParams({ limit: '200' })
      const res = await fetch(
        `/api/admin/intel/discoveries/list?${params.toString()}`,
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
  }, [])

  useEffect(() => {
    setLoading(true)
    fetchList().finally(() => setLoading(false))
  }, [fetchList])

  const grouped = useMemo(() => {
    const out: Record<StatusKey, DiscoveryRow[]> = {
      pending: [],
      in_progress: [],
      validated: [],
      refuted: [],
      dismissed: [],
    }
    for (const d of data?.discoveries ?? []) {
      const status = d.validation_status as StatusKey
      if (out[status]) out[status].push(d)
    }
    return out
  }, [data])

  const pendingByCategory = useMemo(() => {
    const out = new Map<string, DiscoveryRow[]>()
    for (const d of grouped.pending) {
      const arr = out.get(d.hypothesis_category) ?? []
      arr.push(d)
      out.set(d.hypothesis_category, arr)
    }
    // Sort categories by count desc.
    const sorted = Array.from(out.entries()).sort(
      (a, b) => b[1].length - a[1].length,
    )
    return sorted
  }, [grouped.pending])

  async function runEngine() {
    setRunning(true)
    setRunStatus(null)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/discoveries/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
      const body = (await res.json()) as {
        ok: boolean
        error?: string
        inserted?: number
        costCents?: number
        refusals?: Array<{ field: string; reason: string }>
      }
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        return
      }
      const cost =
        typeof body.costCents === 'number' ? body.costCents.toFixed(2) : '0'
      const inserted = body.inserted ?? 0
      const refusalNote =
        (body.refusals ?? []).length > 0
          ? ` (${(body.refusals ?? []).length} refusal${(body.refusals ?? []).length === 1 ? '' : 's'})`
          : ''
      setRunStatus(
        `Discovery run complete: ${inserted} new hypothesis row${inserted === 1 ? '' : 's'}, cost ~${cost}¢.${refusalNote}`,
      )
      await fetchList()
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(msg)
    } finally {
      setRunning(false)
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

  async function action(id: string, actionTaken: string) {
    setBusyId(id)
    try {
      const res = await fetch('/api/admin/intel/discoveries/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discoveryId: id, actionTaken }),
      })
      if (res.ok) {
        await fetchList()
      }
    } finally {
      setBusyId(null)
    }
  }

  async function dismiss(id: string, reason: string) {
    setBusyId(id)
    try {
      const res = await fetch('/api/admin/intel/discoveries/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ discoveryId: id, reason }),
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

  const totalDiscoveries = data?.discoveries?.length ?? 0
  const counts: Record<StatusKey, number> = {
    pending: grouped.pending.length,
    in_progress: grouped.in_progress.length,
    validated: grouped.validated.length,
    refuted: grouped.refuted.length,
    dismissed: grouped.dismissed.length,
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-heading text-2xl font-semibold text-sage-900">
            Discoveries
          </h1>
          <p className="text-sm text-sage-600 mt-1 max-w-2xl">
            Patterns the engine surfaced that the team probably doesn&rsquo;t know
            to look for. Free-form hypotheses (no pre-defined buckets) — the
            engine names the category itself. Aggregate evidence only; no
            couple is named.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={runEngine}
            disabled={running}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs bg-sage-600 text-white rounded-md hover:bg-sage-700 disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5" />
            )}
            {running ? 'Hunting patterns...' : 'Run discovery engine now'}
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

      {runStatus && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2 text-sm text-emerald-700 flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          {runStatus}
        </div>
      )}

      {/* Counts strip */}
      <div className="bg-surface border border-border rounded-xl p-4 shadow-sm flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 text-xs text-sage-500 flex-wrap">
          {STATUS_ORDER.map((s) => (
            <span key={s} className="inline-flex items-center gap-1">
              <span className="font-medium text-sage-700">{counts[s]}</span>
              <span className="text-sage-500">{s.replace(/_/g, ' ')}</span>
            </span>
          ))}
          <span className="ml-auto text-sage-400">
            {totalDiscoveries} total
          </span>
        </div>
      </div>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-2 text-sm text-rose-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {totalDiscoveries === 0 && (
        <div className="bg-surface border border-border rounded-xl p-8 text-center space-y-3">
          <div className="inline-flex items-center justify-center w-12 h-12 bg-sage-50 rounded-full">
            <Lightbulb className="w-6 h-6 text-sage-500" />
          </div>
          <h2 className="font-heading text-lg font-semibold text-sage-900">
            No discoveries yet
          </h2>
          <p className="text-sm text-sage-600 max-w-md mx-auto">
            Run the engine to surface patterns the team doesn&rsquo;t know to
            look for. Other CRMs tell you what you already know — this surface
            tells you what you don&rsquo;t.
          </p>
        </div>
      )}

      {/* Pending — grouped by hypothesis_category for fast visual scan. */}
      {grouped.pending.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="font-heading text-lg font-semibold text-sage-900">
              {STATUS_TITLES.pending}
            </h2>
            <span className="text-xs text-sage-500">
              {grouped.pending.length} pending
            </span>
          </div>
          <p className="text-xs text-sage-500">
            {STATUS_DESCRIPTIONS.pending}
          </p>
          {pendingByCategory.map(([category, rows]) => (
            <div key={category} className="space-y-3">
              <div className="flex items-center gap-2 pl-1">
                <span
                  className={`text-[11px] px-2 py-0.5 rounded border ${categoryColor(category)}`}
                >
                  {humaniseCategory(category)}
                </span>
                <span className="text-[10px] text-sage-400">
                  {rows.length} hypothesis{rows.length === 1 ? '' : 'es'}
                </span>
              </div>
              <div className="space-y-3">
                {rows.map((d) => (
                  <DiscoveryCard
                    key={d.id}
                    d={d}
                    busy={busyId === d.id}
                    onAction={action}
                    onDismiss={dismiss}
                  />
                ))}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Other status sections. */}
      {(['in_progress', 'validated', 'refuted', 'dismissed'] as StatusKey[]).map(
        (status) => {
          const rows = grouped[status]
          if (rows.length === 0) return null
          return (
            <section key={status} className="space-y-3">
              <div className="flex items-baseline justify-between">
                <h2 className="font-heading text-lg font-semibold text-sage-900">
                  {STATUS_TITLES[status]}
                </h2>
                <span className="text-xs text-sage-500">{rows.length}</span>
              </div>
              <p className="text-xs text-sage-500">
                {STATUS_DESCRIPTIONS[status]}
              </p>
              <div className="space-y-3">
                {rows.map((d) => (
                  <DiscoveryCard
                    key={d.id}
                    d={d}
                    busy={busyId === d.id}
                    onAction={action}
                    onDismiss={dismiss}
                  />
                ))}
              </div>
            </section>
          )
        },
      )}

      <div className="text-[10px] text-sage-400 font-mono text-center pt-4">
        discovery-engine.prompt.v1
      </div>
    </div>
  )
}
