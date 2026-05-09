'use client'

/**
 * /agent/brain-dump/grants — coordinator-facing standing-rule audit +
 * candidate promotion (Bugs 6 + 14, 2026-05-09).
 *
 * What this page is FOR:
 *   - List every active brain-dump pattern grant. Each row says
 *     "after the same shape was confirmed N times, you authorised
 *     auto-routing", with hit count + last used + a Revoke button
 *     that flips is_active=false (preserves the audit row).
 *   - List "candidate" patterns: signatures with >= 3 confirmed
 *     entries that have NOT yet hit the 5-confirm auto-offer. The
 *     coordinator can manually offer a grant for any of these
 *     without waiting (Bug 14: pattern intelligence was previously
 *     dead — entries stamped pattern_signature but no surface
 *     showed the cohort).
 *   - List revoked + soft-paused grants below for audit.
 *
 * Pre-fix: the only surface for these grants lived at
 * /settings/brain-dump-log, which most coordinators never opened
 * because it was buried under settings. Same data is still there
 * for the per-entry audit feed; this page is the operations surface
 * a coordinator opens when an unexpected auto-route happens.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Loader2,
  Trash2,
  Brain,
  Clock,
  CheckCircle2,
  Sparkles,
  TrendingUp,
  AlertCircle,
} from 'lucide-react'

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
  is_active: boolean
}

interface Candidate {
  signature: string
  intent: string | null
  confirmedCount: number
  lastConfirmedAt: string
  routedTables: string[]
  samplePreview: string
}

const TABLE_LABELS: Record<string, string> = {
  admin_notifications: 'Notifications',
  marketing_spend: 'Marketing spend',
  pricing_history: 'Pricing log',
  voice_preferences: 'Voice preferences',
  forbidden_topics: 'Forbidden topics',
  weddings: 'Lead profile',
  interactions: 'Email log',
  knowledge_gaps: 'Knowledge gaps',
  knowledge_base: 'Knowledge base',
}

function tableLabel(table: string): string {
  if (TABLE_LABELS[table]) return TABLE_LABELS[table]
  return table.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function formatDate(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return formatDate(iso)
}

export default function BrainDumpGrantsPage() {
  const [grants, setGrants] = useState<Grant[]>([])
  const [candidates, setCandidates] = useState<Candidate[]>([])
  const [minConfirms, setMinConfirms] = useState<number>(3)
  const [loading, setLoading] = useState(true)
  const [candidatesLoading, setCandidatesLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [promotingSig, setPromotingSig] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/brain-dump/grants')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { grants: Grant[] }
      setGrants(json.grants)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load grants')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshCandidates = useCallback(async () => {
    setCandidatesLoading(true)
    try {
      const res = await fetch('/api/brain-dump/grants/candidates')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { candidates: Candidate[]; minConfirmsRequired: number }
      setCandidates(json.candidates)
      setMinConfirms(json.minConfirmsRequired)
    } catch (err) {
      console.warn('[grants] candidates fetch failed:', err)
    } finally {
      setCandidatesLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
    refreshCandidates()
  }, [refresh, refreshCandidates])

  async function revoke(id: string) {
    if (!confirm('Revoke this rule? Future matching brain-dumps will go back to propose-and-confirm. The audit row stays.')) return
    setBusyId(id)
    try {
      const res = await fetch(`/api/brain-dump/grants?id=${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      await Promise.all([refresh(), refreshCandidates()])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Revoke failed')
    } finally {
      setBusyId(null)
    }
  }

  async function promoteCandidate(c: Candidate) {
    const defaultDesc =
      c.intent === 'operational_note'
        ? `Auto-file operational notes matching this shape to knowledge_gaps`
        : c.intent === 'knowledge_base_import'
          ? `Auto-import Q/A rows matching this shape into the knowledge base`
          : `Auto-route brain-dumps matching this shape`
    const description = prompt(
      'Describe this rule (one sentence the audit log will show):',
      defaultDesc,
    )
    if (!description || description.trim().length < 4) return
    setPromotingSig(c.signature)
    try {
      const res = await fetch('/api/brain-dump/grants', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          signature: c.signature,
          intent: c.intent ?? 'operational_note',
          description: description.trim(),
          routedTable: c.routedTables[0] ?? null,
          routedAction: 'insert_via_grant',
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      await Promise.all([refresh(), refreshCandidates()])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Promote failed')
    } finally {
      setPromotingSig(null)
    }
  }

  const active = grants.filter((g) => g.is_active && !g.revoked_at)
  const inactive = grants.filter((g) => !g.is_active || g.revoked_at)

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="font-heading text-3xl font-semibold text-sage-900 flex items-center gap-2">
          <Brain className="w-7 h-7" />
          Brain-dump rules
        </h1>
        <p className="text-sm text-sage-600 mt-2 max-w-2xl">
          Standing rules you authorised after confirming the same brain-dump shape three or more times. Future matching entries auto-route without a per-instance confirmation. Revoke a rule any time; the audit row stays so you can see what fired and when.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 flex items-center gap-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {/* Active grants */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500 flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            Active rules ({active.length})
          </h2>
        </div>
        {loading && grants.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-sage-500 py-12 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading rules…
          </div>
        ) : active.length === 0 ? (
          <div className="rounded-lg border border-sage-200 bg-warm-white p-6 text-center text-sm text-sage-500">
            No active rules. After you confirm the same brain-dump shape five times, you&apos;ll be offered a rule on the next confirm. Or promote a candidate below to graduate one early.
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
                      {g.routed_table && (
                        <span className="font-mono">
                          {`-> ${tableLabel(g.routed_table)}${g.routed_action ? `:${g.routed_action}` : ''}`}
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" /> granted {formatDate(g.granted_at)}
                      </span>
                      <span>
                        {g.hit_count} use{g.hit_count === 1 ? '' : 's'}
                        {g.last_used_at ? `, last ${timeAgo(g.last_used_at)}` : ''}
                      </span>
                    </div>
                  </div>
                  <button
                    onClick={() => revoke(g.id)}
                    disabled={busyId === g.id}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-sage-300 hover:border-red-300 hover:bg-red-50 hover:text-red-700 text-sage-600 disabled:opacity-50"
                  >
                    {busyId === g.id ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Trash2 className="w-3 h-3" />
                    )}
                    Revoke
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Candidate patterns — Bug 14 */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500 flex items-center gap-2">
            <TrendingUp className="w-3.5 h-3.5 text-amber-500" />
            Patterns to consider ({candidates.length})
          </h2>
        </div>
        <p className="text-xs text-sage-500 mb-2">
          Brain-dump shapes you&apos;ve confirmed at least {minConfirms} times in the last 30 days. Promote one to a standing rule and future matching entries route automatically without the propose-and-confirm round-trip.
        </p>
        {candidatesLoading && candidates.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-sage-500 py-8 justify-center">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading patterns…
          </div>
        ) : candidates.length === 0 ? (
          <div className="rounded-lg border border-sage-200 bg-warm-white p-6 text-center text-sm text-sage-500">
            No repeat patterns yet. Once you&apos;ve confirmed the same shape {minConfirms}+ times, candidates appear here.
          </div>
        ) : (
          <ul className="space-y-2">
            {candidates.map((c) => (
              <li
                key={c.signature}
                className="rounded-lg border border-amber-200 bg-amber-50/30 p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <span className="text-xs font-semibold text-amber-800 bg-amber-100 px-1.5 py-0.5 rounded">
                        {c.confirmedCount} confirmed
                      </span>
                      {c.intent && (
                        <span className="font-mono text-[11px] text-sage-700 bg-sage-50 px-1.5 py-0.5 rounded">
                          intent: {c.intent}
                        </span>
                      )}
                      {c.routedTables.map((t) => (
                        <span
                          key={t}
                          className="text-[11px] text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded"
                        >
                          {`-> ${tableLabel(t)}`}
                        </span>
                      ))}
                      <span className="text-[11px] text-sage-500 inline-flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        last {timeAgo(c.lastConfirmedAt)}
                      </span>
                    </div>
                    <p className="text-sm text-sage-800 leading-snug whitespace-pre-wrap break-words">
                      {c.samplePreview}
                      {c.samplePreview.length >= 160 ? '…' : ''}
                    </p>
                    <div className="text-[10px] text-sage-400 font-mono mt-1">
                      sig: {c.signature}
                    </div>
                  </div>
                  <button
                    onClick={() => promoteCandidate(c)}
                    disabled={promotingSig === c.signature}
                    className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded bg-sage-500 hover:bg-sage-600 text-white disabled:opacity-50 shrink-0"
                  >
                    {promotingSig === c.signature ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Sparkles className="w-3 h-3" />
                    )}
                    Promote to rule
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Revoked / soft-paused */}
      {inactive.length > 0 && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-sage-500 mb-2">
            Revoked + paused ({inactive.length})
          </h2>
          <ul className="space-y-2">
            {inactive.map((g) => (
              <li
                key={g.id}
                className="rounded-lg border border-sage-200 bg-sage-50/30 p-4 opacity-70"
              >
                <div className="text-sm text-sage-700 line-through">{g.description}</div>
                <div className="text-xs text-sage-500 mt-1">
                  {g.revoked_at ? `Revoked ${formatDate(g.revoked_at)}` : 'Paused'} · {g.hit_count} use{g.hit_count === 1 ? '' : 's'} before
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
