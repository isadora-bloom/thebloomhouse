'use client'

/**
 * /admin/identity/handle-merges
 *
 * Anchors:
 *   - migration 259 (handle_merge_decisions)
 *   - /api/admin/identity/handle-merge-proposals (GET)
 *   - /api/admin/identity/handle-merges/[handle]/{accept,reject,defer}
 *
 * Surfaces the cross-platform handle-merge proposals from
 * crossPlatformHandleMerge() for coordinator review. The constitution's
 * Tenant 2 promise — "rosaliehoyle on Pinterest AND Knot AND
 * r.hoyle@gmail.com claiming Rosalie Hoyle merges into one forensic
 * record" — depended on a coordinator being able to accept these
 * proposals. Until this page shipped, the API existed but no UI did,
 * so the proposals just rotted.
 *
 * Coordinator workflow:
 *   - Review live proposals top-down (highest score first).
 *   - Accept the obvious cross-platform convergences (rosaliehoyle on
 *     3 platforms, all consistent first names).
 *   - Defer the ambiguous (one-platform-only, or names half-match).
 *   - Reject false positives (Sarah on one platform vs Mark on another
 *     with the same handle = shared household account, not same person).
 *   - Past decisions render in the Audit history tab.
 */

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Network,
  ArrowLeft,
  Check,
  X,
  Clock,
  AlertTriangle,
  Users,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  History,
} from 'lucide-react'

type Decision = 'accepted' | 'rejected' | 'deferred' | null

interface ProposalRecord {
  kind: 'people' | 'candidate_identities'
  recordId: string
  rawHandle: string
  normalizedHandle: string
  platform: string
  firstName: string | null
  lastName: string | null
  email: string | null
}

interface Proposal {
  handle: string
  score: number
  mixed: boolean
  platforms: string[]
  reasoning: string[]
  records: ProposalRecord[]
  decision: Decision
  decided_at: string | null
  decided_by: string | null
  note: string | null
}

interface ProposalsResponse {
  ok: boolean
  venueId?: string
  handlesInspected?: number
  proposalsFound?: number
  live?: Proposal[]
  audit?: Proposal[]
  error?: string
}

function scoreColor(score: number): string {
  if (score >= 80) return 'text-emerald-700 bg-emerald-50 border-emerald-200'
  if (score >= 50) return 'text-amber-700 bg-amber-50 border-amber-200'
  return 'text-rose-700 bg-rose-50 border-rose-200'
}

function platformChipColor(platform: string): string {
  // No semantic colour by platform — just a soft chip per platform so
  // multi-platform convergence reads visually distinct.
  return 'bg-sage-50 text-sage-700 border-sage-200'
}

export default function HandleMergesPage() {
  const [live, setLive] = useState<Proposal[]>([])
  const [audit, setAudit] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [actingOn, setActingOn] = useState<string | null>(null) // handle currently being acted on
  const [showAudit, setShowAudit] = useState(false)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const expandedIds = useMemo(() => expanded, [expanded])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/identity/handle-merge-proposals', {
        cache: 'no-store',
      })
      const json = (await res.json()) as ProposalsResponse
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `HTTP ${res.status}`)
      }
      setLive(json.live ?? [])
      setAudit(json.audit ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [])

  async function decide(handle: string, action: 'accept' | 'reject' | 'defer') {
    setActingOn(handle)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch(
        `/api/admin/identity/handle-merges/${encodeURIComponent(handle)}/${action}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      if (action === 'accept') {
        setInfo(
          json.candidate_only
            ? `Recorded acceptance for ${handle} (candidate-only, no people merge needed).`
            : `Accepted ${handle} — merged ${json.merged_pairs} pair${json.merged_pairs === 1 ? '' : 's'}.`,
        )
      } else if (action === 'reject') {
        setInfo(`Rejected ${handle}.`)
      } else {
        setInfo(`Deferred ${handle} — will stay surfaced for later review.`)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally {
      setActingOn(null)
    }
  }

  function toggleExpand(handle: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(handle)) next.delete(handle)
      else next.add(handle)
      return next
    })
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-8">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="flex items-center gap-3">
            <Link
              href="/admin/identity"
              className="text-sage-600 hover:text-sage-900 text-sm flex items-center gap-1"
            >
              <ArrowLeft className="w-4 h-4" />
              Identity
            </Link>
          </div>
          <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-3 mt-2">
            <Network className="w-6 h-6 text-sage-700" />
            Handle convergence
          </h1>
          <p className="text-sage-600 mt-2 text-sm max-w-2xl">
            Same handle observed across multiple records or platforms.
            Strong same-person signals merge here so a single forensic
            identity gets one canonical record per Constitution Tenant 2.
          </p>
        </div>
        <button
          onClick={() => void load()}
          className="flex items-center gap-2 px-3 py-2 text-sage-700 border border-sage-300 text-sm rounded-lg hover:bg-sage-50 disabled:opacity-50 whitespace-nowrap"
          disabled={loading}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </header>

      {error && (
        <div className="bg-rose-50 border border-rose-200 rounded-lg px-4 py-3 text-sm text-rose-800 flex items-start gap-2">
          <AlertTriangle className="w-5 h-5 mt-0.5" />
          {error}
        </div>
      )}
      {info && (
        <div className="bg-sage-50 border border-sage-200 rounded-lg px-4 py-3 text-sm text-sage-800">
          {info}
        </div>
      )}

      <section>
        <h2 className="text-base font-medium text-sage-900 mb-3 flex items-center gap-2">
          <Users className="w-4 h-4" />
          Live proposals
          <span className="text-sm text-sage-500">({live.length})</span>
        </h2>
        {loading ? (
          <div className="text-sm text-sage-500">Loading proposals...</div>
        ) : live.length === 0 ? (
          <div className="text-sm text-sage-500 italic border border-dashed border-sage-200 rounded-lg p-6 text-center">
            No live proposals. The matcher checks for shared handles
            across people + candidate_identities + tangential_signals
            and surfaces 2+ converging records.
          </div>
        ) : (
          <ul className="space-y-3">
            {live.map((p) => {
              const isExpanded = expandedIds.has(p.handle)
              const isActing = actingOn === p.handle
              const isDeferred = p.decision === 'deferred'
              return (
                <li
                  key={p.handle}
                  className="bg-white border border-sage-200 rounded-lg overflow-hidden"
                >
                  <div className="p-4 flex items-start gap-4">
                    <div className="flex-1 min-w-0 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <code className="font-mono text-sage-900 text-base">
                          @{p.handle}
                        </code>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 text-xs rounded-md border ${scoreColor(p.score)}`}
                          title="Heuristic confidence — higher = more certain same-person"
                        >
                          score {p.score}
                        </span>
                        {p.mixed && (
                          <span className="inline-flex items-center px-2 py-0.5 text-xs rounded-md border border-gold-200 bg-gold-50 text-gold-700">
                            pre-zero ↔ post-zero
                          </span>
                        )}
                        {isDeferred && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md border border-teal-200 bg-teal-50 text-teal-700">
                            <Clock className="w-3 h-3" />
                            deferred
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {p.platforms.map((platform) => (
                          <span
                            key={platform}
                            className={`inline-flex items-center px-2 py-0.5 text-[11px] rounded-md border ${platformChipColor(platform)}`}
                          >
                            {platform}
                          </span>
                        ))}
                        <span className="text-xs text-sage-500">
                          · {p.records.length} record{p.records.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      {p.note && (
                        <div className="text-xs text-sage-600 italic">
                          Note: {p.note}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => void decide(p.handle, 'accept')}
                        disabled={isActing}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-sage-500 text-white rounded-md hover:bg-sage-600 disabled:opacity-50"
                        title="Accept merge — fires mergePeople for each pair on the proposal"
                      >
                        <Check className="w-4 h-4" />
                        Accept
                      </button>
                      <button
                        onClick={() => void decide(p.handle, 'defer')}
                        disabled={isActing || isDeferred}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-sage-300 text-sage-700 rounded-md hover:bg-sage-50 disabled:opacity-50"
                        title="Stay in the live list but sink to the bottom"
                      >
                        <Clock className="w-4 h-4" />
                        Defer
                      </button>
                      <button
                        onClick={() => void decide(p.handle, 'reject')}
                        disabled={isActing}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-rose-200 text-rose-700 rounded-md hover:bg-rose-50 disabled:opacity-50"
                        title="Reject — files as audit, removes from live list"
                      >
                        <X className="w-4 h-4" />
                        Reject
                      </button>
                    </div>
                  </div>
                  <div className="border-t border-sage-100 px-4 py-2 flex items-center justify-between text-xs text-sage-600">
                    <button
                      onClick={() => toggleExpand(p.handle)}
                      className="flex items-center gap-1 hover:text-sage-900"
                    >
                      {isExpanded ? (
                        <>
                          <ChevronUp className="w-3.5 h-3.5" />
                          Hide details
                        </>
                      ) : (
                        <>
                          <ChevronDown className="w-3.5 h-3.5" />
                          View {p.records.length} record{p.records.length === 1 ? '' : 's'} + reasoning
                        </>
                      )}
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="border-t border-sage-100 bg-sage-50/40 px-4 py-3 space-y-3">
                      <div>
                        <div className="text-xs font-medium text-sage-800 mb-1">
                          Reasoning
                        </div>
                        <ul className="text-xs text-sage-700 space-y-0.5 list-disc list-inside">
                          {p.reasoning.map((r, i) => (
                            <li key={i}>{r}</li>
                          ))}
                        </ul>
                      </div>
                      <div>
                        <div className="text-xs font-medium text-sage-800 mb-1">
                          Records
                        </div>
                        <ul className="space-y-1">
                          {p.records.map((r) => (
                            <li
                              key={`${r.kind}:${r.recordId}`}
                              className="text-xs text-sage-700 grid grid-cols-[120px_1fr] gap-2 items-baseline"
                            >
                              <span className="font-mono text-sage-500 truncate">
                                {r.kind === 'people' ? 'people' : r.recordId.startsWith('orphan-signal:') ? 'orphan' : 'candidate'}
                              </span>
                              <span className="truncate">
                                <span className={`inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border mr-1 ${platformChipColor(r.platform)}`}>
                                  {r.platform}
                                </span>
                                {[r.firstName, r.lastName].filter(Boolean).join(' ') || '(no name)'}
                                {r.email ? ` · ${r.email}` : ''}
                                <span className="text-sage-400 font-mono ml-2">
                                  {r.recordId.replace('orphan-signal:', '').slice(0, 8)}
                                </span>
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section>
        <button
          onClick={() => setShowAudit((v) => !v)}
          className="flex items-center gap-2 text-sm text-sage-700 hover:text-sage-900"
        >
          <History className="w-4 h-4" />
          {showAudit ? 'Hide' : 'Show'} decision history
          <span className="text-sage-500">({audit.length})</span>
          {showAudit ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {showAudit && (
          audit.length === 0 ? (
            <div className="mt-3 text-sm text-sage-500 italic border border-dashed border-sage-200 rounded-lg p-4 text-center">
              No accepted/rejected decisions recorded yet.
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-sage-100 bg-white border border-sage-200 rounded-lg">
              {audit.map((p) => (
                <li
                  key={p.handle}
                  className="p-3 flex items-center gap-4 text-sm"
                >
                  <code className="font-mono text-sage-900 flex-1 min-w-0 truncate">
                    @{p.handle}
                  </code>
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md border ${
                      p.decision === 'accepted'
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : 'border-rose-200 bg-rose-50 text-rose-700'
                    }`}
                  >
                    {p.decision === 'accepted' ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
                    {p.decision}
                  </span>
                  <span className="text-xs text-sage-500 whitespace-nowrap">
                    {p.decided_at ? new Date(p.decided_at).toLocaleString() : '—'}
                  </span>
                </li>
              ))}
            </ul>
          )
        )}
      </section>
    </div>
  )
}
