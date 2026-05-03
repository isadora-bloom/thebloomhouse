'use client'

/**
 * /settings/brain-dump-log — graduated pattern audit + 30-day entry log.
 *
 * Lists active brain-dump pattern grants — standing rules the
 * coordinator authorised after 3+ confirmations of the same shape.
 * Each row shows description + intent + hit count + last used, with
 * a Revoke button that re-engages propose-and-confirm for future
 * matching entries.
 *
 * T5-γ.7 (2026-05-02): added "Recent entries (30d)" section so the
 * page is the audit log it claimed to be. Pre-fix the page only
 * rendered grants — the per-submission record (parse_status, routed
 * table, intent, original input) was written but never surfaced.
 * Coordinator can now answer "what did Sage do with each thing I
 * dropped in over the last month?" alongside the standing-rule
 * abstractions.
 */

import { useState, useEffect, useCallback } from 'react'
import { Loader2, Trash2, Brain, Clock, FileText, AlertTriangle, CheckCircle2, XCircle, ListFilter } from 'lucide-react'
import { useAiName } from '@/lib/hooks/use-ai-name'

// Coordinator-friendly labels for raw DB table names. Avoids leaking
// schema identifiers like "admin_notifications" / "voice_preferences"
// into the brain-dump entry log badges.
const TABLE_LABELS: Record<string, string> = {
  admin_notifications: 'Notifications',
  marketing_spend: 'Marketing spend',
  pricing_history: 'Pricing log',
  voice_preferences: 'Voice preferences',
  forbidden_topics: 'Forbidden topics',
  weddings: 'Lead profile',
  interactions: 'Email log',
}

function tableLabel(table: string): string {
  if (TABLE_LABELS[table]) return TABLE_LABELS[table]
  // Fallback: title-case + replace underscores with spaces.
  return table
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

interface Grant {
  id: string
  pattern_signature: string
  description: string
  intent: string
  routed_table: string | null
  routed_action: string | null
  granted_at: string
  hit_count: number
  last_used_at: string | null
  revoked_at: string | null
}

interface BrainDumpEntry {
  id: string
  raw_input: string
  raw_input_excerpt: string
  input_type: string
  parse_status: string
  intent: string | null
  routed_table: string | null
  routed_to: Array<{ table?: string; action?: string; field?: string }>
  clarification_question: string | null
  clarification_answer: string | null
  submitter_name: string | null
  created_at: string
  parsed_at: string | null
  resolved_at: string | null
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function statusBadge(status: string): { bg: string; text: string; label: string; Icon: typeof CheckCircle2 } {
  switch (status) {
    case 'parsed':
    case 'confirmed':
      return { bg: 'bg-emerald-50', text: 'text-emerald-700', label: status === 'confirmed' ? 'Confirmed' : 'Parsed', Icon: CheckCircle2 }
    case 'needs_clarification':
      return { bg: 'bg-amber-50', text: 'text-amber-700', label: 'Needs clarification', Icon: AlertTriangle }
    case 'dismissed':
      return { bg: 'bg-sage-50', text: 'text-sage-600', label: 'Dismissed', Icon: XCircle }
    case 'pending':
    default:
      return { bg: 'bg-blue-50', text: 'text-blue-700', label: 'Pending', Icon: Loader2 }
  }
}

export default function BrainDumpLogPage() {
  const aiName = useAiName()
  const [grants, setGrants] = useState<Grant[]>([])
  const [entries, setEntries] = useState<BrainDumpEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [entriesLoading, setEntriesLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [entriesError, setEntriesError] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('all')

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/brain-dump/grants')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { grants: Grant[] }
      setGrants(json.grants)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshEntries = useCallback(async () => {
    setEntriesLoading(true)
    try {
      const res = await fetch('/api/brain-dump/entries')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { entries: BrainDumpEntry[] }
      setEntries(json.entries)
      setEntriesError(null)
    } catch (err) {
      setEntriesError(err instanceof Error ? err.message : 'Failed to load entries')
    } finally {
      setEntriesLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => { refreshEntries() }, [refreshEntries])

  async function revoke(id: string) {
    if (!confirm('Revoke this grant? Future matching brain-dumps will go back to propose-and-confirm.')) return
    setRevoking(id)
    try {
      const res = await fetch(`/api/brain-dump/grants?id=${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed')
    } finally {
      setRevoking(null)
    }
  }

  const active = grants.filter((g) => !g.revoked_at)
  const revoked = grants.filter((g) => g.revoked_at)

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-semibold text-sage-900 flex items-center gap-2">
          <Brain className="w-7 h-7" />
          Brain-dump rules
        </h1>
        <p className="text-sm text-sage-600 mt-2">
          Standing rules you confirmed after 3+ matching brain-dumps. Future brain-dumps with the same shape route automatically — no per-instance confirmation needed. Revoke a rule to re-engage propose-and-confirm.
        </p>
      </div>

      {loading && grants.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-sage-500 py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{error}</div>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500 mb-2">
          Active rules ({active.length})
        </h2>
        {active.length === 0 ? (
          <div className="rounded-lg border border-sage-200 bg-warm-white p-6 text-center text-sm text-sage-500">
            No active rules yet. After you confirm the same brain-dump shape 3 times, you&apos;ll be offered a rule prompt.
          </div>
        ) : (
          <ul className="space-y-2">
            {active.map((g) => (
              <li key={g.id} className="rounded-lg border border-sage-200 bg-warm-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-sage-900">{g.description}</div>
                    <div className="text-xs text-sage-500 mt-1 flex items-center gap-3 flex-wrap">
                      <span className="font-mono">intent: {g.intent}</span>
                      {g.routed_table && <span className="font-mono">→ {g.routed_table}{g.routed_action ? `:${g.routed_action}` : ''}</span>}
                      <span className="inline-flex items-center gap-1"><Clock className="w-3 h-3" /> granted {formatDate(g.granted_at)}</span>
                      <span>{g.hit_count} use{g.hit_count === 1 ? '' : 's'}{g.last_used_at ? `, last ${formatDate(g.last_used_at)}` : ''}</span>
                    </div>
                  </div>
                  <button
                    onClick={() => revoke(g.id)}
                    disabled={revoking === g.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-sage-300 hover:border-red-300 hover:bg-red-50 hover:text-red-700 text-sage-600 disabled:opacity-50"
                  >
                    {revoking === g.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {revoked.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500 mb-2">
            Revoked ({revoked.length})
          </h2>
          <ul className="space-y-2">
            {revoked.map((g) => (
              <li key={g.id} className="rounded-lg border border-sage-200 bg-sage-50/30 p-4 opacity-70">
                <div className="text-sm text-sage-700 line-through">{g.description}</div>
                <div className="text-xs text-sage-500 mt-1">
                  Revoked {formatDate(g.revoked_at)} · {g.hit_count} use{g.hit_count === 1 ? '' : 's'} before revoke
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* T5-γ.7: per-entry audit log. The grants section above shows
          standing-rule abstractions ("after 3 confirmations of the
          same shape"); this section shows the raw submission feed
          underneath. Coordinator can audit "what did Sage do with
          each thing I dropped in over the last month?" without
          needing the SQL editor. */}
      <section>
        <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500 flex items-center gap-2">
              <FileText className="w-3.5 h-3.5" />
              Recent entries (30d)
            </h2>
            <p className="text-xs text-sage-500 mt-1">
              Every brain-dump submission for the last 30 days, newest first. Limit 50.
            </p>
          </div>
          <div className="flex items-center gap-1 text-xs">
            <ListFilter className="w-3 h-3 text-sage-400" />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-sage-200 rounded px-2 py-1 text-xs bg-warm-white text-sage-700"
            >
              <option value="all">All statuses</option>
              <option value="parsed">Parsed</option>
              <option value="confirmed">Confirmed</option>
              <option value="needs_clarification">Needs clarification</option>
              <option value="pending">Pending</option>
              <option value="dismissed">Dismissed</option>
            </select>
          </div>
        </div>

        {entriesLoading && entries.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-sage-500 py-12 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading entries…
          </div>
        ) : entriesError ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{entriesError}</div>
        ) : entries.length === 0 ? (
          <div className="rounded-lg border border-sage-200 bg-warm-white p-6 text-center text-sm text-sage-500">
            No brain-dump entries in the last 30 days. As you tell {aiName} things, they&apos;ll appear here.
          </div>
        ) : (
          <ul className="space-y-2">
            {entries
              .filter((e) => statusFilter === 'all' || e.parse_status === statusFilter)
              .map((e) => {
                const badge = statusBadge(e.parse_status)
                const StatusIcon = badge.Icon
                return (
                  <li key={e.id} className="rounded-lg border border-sage-200 bg-warm-white p-4">
                    <div className="flex items-start justify-between gap-3 mb-2 flex-wrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${badge.bg} ${badge.text}`}>
                          <StatusIcon className="w-3 h-3" />
                          {badge.label}
                        </span>
                        {e.intent && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-sage-50 text-sage-700">
                            intent: {e.intent}
                          </span>
                        )}
                        {e.routed_table && (
                          <span
                            className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-50 text-blue-700"
                            title={`routed to ${e.routed_table}`}
                          >
                            → {tableLabel(e.routed_table)}
                          </span>
                        )}
                        {e.input_type !== 'text' && (
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-mono bg-sage-50 text-sage-600">
                            {e.input_type}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-sage-500 flex items-center gap-2 shrink-0">
                        <Clock className="w-3 h-3" />
                        {formatDateTime(e.created_at)}
                        {e.submitter_name && (
                          <span className="text-sage-400">· {e.submitter_name}</span>
                        )}
                      </div>
                    </div>
                    <p className="text-sm text-sage-800 leading-snug whitespace-pre-wrap break-words">
                      {e.raw_input_excerpt}
                      {e.raw_input.length > e.raw_input_excerpt.length && '…'}
                    </p>
                    {e.clarification_question && (
                      <div className="mt-2 text-xs text-amber-800 bg-amber-50/60 border border-amber-200 rounded p-2">
                        <strong className="font-semibold">Clarification asked:</strong> {e.clarification_question}
                        {e.clarification_answer && (
                          <div className="mt-1 text-sage-700">
                            <strong className="font-semibold">Answer:</strong> {e.clarification_answer}
                          </div>
                        )}
                      </div>
                    )}
                    {e.routed_to.length > 1 && (
                      <details className="mt-2">
                        <summary className="text-xs text-sage-500 cursor-pointer hover:text-sage-700">
                          {e.routed_to.length} routing target{e.routed_to.length === 1 ? '' : 's'}
                        </summary>
                        <ul className="mt-1 space-y-0.5 text-[11px] font-mono text-sage-600 pl-4 list-disc">
                          {e.routed_to.map((r, idx) => (
                            <li key={idx}>
                              {r.table ?? '?'}{r.field ? `.${r.field}` : ''}{r.action ? ` (${r.action})` : ''}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </li>
                )
              })}
          </ul>
        )}
      </section>
    </div>
  )
}
