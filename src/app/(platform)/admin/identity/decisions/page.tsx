'use client'

/**
 * /admin/identity/decisions — Wave 10 person-keyed identity decision UX.
 *
 * Anchors:
 *   - src/lib/services/identity/decision-clustering/cluster-proposals.ts
 *   - /api/admin/identity/decision-clusters (GET, accept, reject, defer)
 *   - migration 277 (identity_decision_clusters)
 *
 * The bug this page closes
 * ------------------------
 * "Jamie B" appeared as 4 separate handle proposals on the legacy
 * /admin/identity/handle-merges page — one per cross-platform handle
 * she had. Operator clicked accept on one, the merge cascaded, and the
 * other 3 disappeared on refresh. The UX presented 4 decisions when
 * only 1 was actually needed.
 *
 * This page replaces the per-handle row pattern with per-cluster
 * cards. Each card represents ONE real person, with N handles backing
 * the cluster (sorted by handle score). Accept-cluster sweeps every
 * handle atomically.
 *
 * Power users can still inspect raw handle proposals via the link to
 * /admin/identity/handle-merges (kept intact for backwards compat).
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import {
  Users,
  ArrowLeft,
  AlertTriangle,
  RefreshCw,
  History,
  ChevronUp,
  ChevronDown,
  Network,
  Check,
  X,
  Clock,
} from 'lucide-react'
import {
  PersonClusterCard,
  type ClusterCardData,
} from '@/components/identity/PersonClusterCard'

interface HistoryHandle {
  handle: string
  platforms: string[]
  score: number
  recordCount: number
}

interface HistoryRow {
  id: string
  clusterKey: string
  canonicalPersonId: string | null
  handlesInvolved: HistoryHandle[] | null
  totalRecords: number
  aggregateScore: number
  decision: 'accepted' | 'rejected' | 'deferred'
  decisionNote: string | null
  decidedAt: string
  decidedBy: string | null
}

interface DecisionClustersResponse {
  ok: boolean
  venueId?: string
  pending?: ClusterCardData[]
  history?: HistoryRow[]
  stats?: {
    proposalsLive: number
    proposalsTotal: number
    clustersBuilt: number
    clustersPending: number
  }
  llmJudgeInvocations?: number
  error?: string
}

function decisionPill(decision: HistoryRow['decision']) {
  const base = 'inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md border'
  if (decision === 'accepted') {
    return `${base} border-emerald-200 bg-emerald-50 text-emerald-700`
  }
  if (decision === 'rejected') {
    return `${base} border-rose-200 bg-rose-50 text-rose-700`
  }
  return `${base} border-teal-200 bg-teal-50 text-teal-700`
}

export default function IdentityDecisionsPage() {
  const [pending, setPending] = useState<ClusterCardData[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [stats, setStats] = useState<DecisionClustersResponse['stats']>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [actingOn, setActingOn] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/identity/decision-clusters', { cache: 'no-store' })
      const json = (await res.json()) as DecisionClustersResponse
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      setPending(json.pending ?? [])
      setHistory(json.history ?? [])
      setStats(json.stats)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  async function decide(clusterKey: string, action: 'accept' | 'reject' | 'defer') {
    setActingOn(clusterKey)
    setError(null)
    setInfo(null)
    try {
      const res = await fetch(
        `/api/admin/identity/decision-clusters/${encodeURIComponent(clusterKey)}/${action}`,
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
          `Accepted ${json.displayName ?? clusterKey} — swept ${json.handlesAccepted} handle${json.handlesAccepted === 1 ? '' : 's'} (${json.peopleMerged} pair${json.peopleMerged === 1 ? '' : 's'} merged${json.errors ? `, ${json.errors} error${json.errors === 1 ? '' : 's'}` : ''}).`,
        )
      } else if (action === 'reject') {
        setInfo(`Rejected ${json.displayName ?? clusterKey} — ${json.handlesDecided} handle${json.handlesDecided === 1 ? '' : 's'} marked rejected.`)
      } else {
        setInfo(`Deferred ${json.displayName ?? clusterKey} — will stay surfaced for later review.`)
      }
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${action}`)
    } finally {
      setActingOn(null)
    }
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
            <Users className="w-6 h-6 text-sage-700" />
            Identity decisions
          </h1>
          <p className="text-sage-600 mt-2 text-sm max-w-2xl">
            One decision per real person, not N per handle. Handle
            proposals that converge on the same canonical identity are
            grouped into a single cluster card so accept/reject/defer
            sweeps all platforms atomically.
          </p>
          {stats && (
            <div className="mt-2 text-xs text-sage-500">
              {stats.proposalsLive} live handle proposal{stats.proposalsLive === 1 ? '' : 's'} ·{' '}
              {stats.clustersPending} pending cluster{stats.clustersPending === 1 ? '' : 's'} ·{' '}
              {stats.proposalsTotal} total proposal{stats.proposalsTotal === 1 ? '' : 's'} considered
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/admin/identity/handle-merges"
            className="flex items-center gap-2 px-3 py-2 text-sage-700 border border-sage-300 text-sm rounded-lg hover:bg-sage-50 whitespace-nowrap"
            title="View the legacy per-handle proposal queue"
          >
            <Network className="w-4 h-4" />
            Raw handle proposals
          </Link>
          <button
            type="button"
            onClick={() => void load()}
            className="flex items-center gap-2 px-3 py-2 text-sage-700 border border-sage-300 text-sm rounded-lg hover:bg-sage-50 disabled:opacity-50 whitespace-nowrap"
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
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
          Pending clusters
          <span className="text-sm text-sage-500">({pending.length})</span>
        </h2>
        {loading ? (
          <div className="text-sm text-sage-500">Loading clusters...</div>
        ) : pending.length === 0 ? (
          <div className="text-sm text-sage-500 italic border border-dashed border-sage-200 rounded-lg p-6 text-center">
            No pending clusters. Every handle proposal has either been
            decided already or has not yet found a converging counterpart.
          </div>
        ) : (
          <div className="space-y-3">
            {pending.map((cluster) => (
              <PersonClusterCard
                key={cluster.clusterId}
                cluster={cluster}
                busy={actingOn === cluster.clusterKey}
                onAccept={(k) => void decide(k, 'accept')}
                onReject={(k) => void decide(k, 'reject')}
                onDefer={(k) => void decide(k, 'defer')}
              />
            ))}
          </div>
        )}
      </section>

      <section>
        <button
          type="button"
          onClick={() => setShowHistory((v) => !v)}
          className="flex items-center gap-2 text-sm text-sage-700 hover:text-sage-900"
        >
          <History className="w-4 h-4" />
          {showHistory ? 'Hide' : 'Show'} decision history
          <span className="text-sage-500">({history.length})</span>
          {showHistory ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
        {showHistory && (
          history.length === 0 ? (
            <div className="mt-3 text-sm text-sage-500 italic border border-dashed border-sage-200 rounded-lg p-4 text-center">
              No cluster decisions recorded yet.
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-sage-100 bg-white border border-sage-200 rounded-lg">
              {history.map((row) => (
                <li key={row.id} className="p-3 text-sm">
                  <div className="flex items-center gap-4">
                    <code className="font-mono text-sage-900 flex-1 min-w-0 truncate text-xs">
                      {row.clusterKey}
                    </code>
                    <span className={decisionPill(row.decision)}>
                      {row.decision === 'accepted' && <Check className="w-3 h-3" />}
                      {row.decision === 'rejected' && <X className="w-3 h-3" />}
                      {row.decision === 'deferred' && <Clock className="w-3 h-3" />}
                      {row.decision}
                    </span>
                    <span className="text-xs text-sage-500 whitespace-nowrap">
                      {row.decidedAt ? new Date(row.decidedAt).toLocaleString() : '—'}
                    </span>
                  </div>
                  {row.handlesInvolved && row.handlesInvolved.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {row.handlesInvolved.slice(0, 6).map((h, i) => (
                        <span
                          key={`${row.id}-${i}`}
                          className="inline-flex items-center px-1.5 py-0.5 text-[10px] rounded border bg-sage-50 border-sage-200 text-sage-700"
                        >
                          <span className="font-mono mr-1">{(h.platforms ?? []).join('/')}</span>
                          {h.handle}
                        </span>
                      ))}
                      {row.handlesInvolved.length > 6 && (
                        <span className="text-[10px] text-sage-500">+{row.handlesInvolved.length - 6} more</span>
                      )}
                    </div>
                  )}
                  {row.decisionNote && (
                    <div className="mt-1 text-xs text-sage-500 italic">{row.decisionNote}</div>
                  )}
                </li>
              ))}
            </ul>
          )
        )}
      </section>
    </div>
  )
}
