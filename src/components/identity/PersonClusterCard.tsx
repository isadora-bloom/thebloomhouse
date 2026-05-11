'use client'

/**
 * PersonClusterCard — Wave 10 cluster card for /admin/identity/decisions.
 *
 * One card = one real person. Renders:
 *   - Display name (large)
 *   - Aggregate score pill
 *   - Per-platform handle chips (e.g. "gmail: jamie.b@... | knot: jamie.b.123...")
 *   - Total records + first/last observed timestamps
 *   - Collapsible reasoning chain
 *   - Action row: Accept / Defer / Reject
 *
 * Anchor docs:
 *   - src/lib/services/identity/decision-clustering/cluster-proposals.ts
 *   - bloom-constitution.md
 */

import { useState } from 'react'
import {
  Check,
  X,
  Clock,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Calendar,
  Layers,
} from 'lucide-react'

export interface ClusterCardHandle {
  handle: string
  platforms: string[]
  score: number
  recordCount: number
  reasoning: string[]
  mixed: boolean
}

export interface ClusterCardData {
  clusterId: string
  clusterKey: string
  canonicalPersonId: string | null
  displayName: string
  handles: ClusterCardHandle[]
  totalRecords: number
  aggregateScore: number
  reasoning: string[]
  firstObservedAt: string | null
  lastObservedAt: string | null
  llmBridged: boolean
  llmConfidence: number | null
}

interface PersonClusterCardProps {
  cluster: ClusterCardData
  busy?: boolean
  onAccept?: (clusterKey: string) => void
  onReject?: (clusterKey: string) => void
  onDefer?: (clusterKey: string) => void
}

function scorePillClasses(score: number): string {
  if (score >= 80) return 'text-emerald-700 bg-emerald-50 border-emerald-200'
  if (score >= 50) return 'text-amber-700 bg-amber-50 border-amber-200'
  return 'text-rose-700 bg-rose-50 border-rose-200'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleDateString()
  } catch {
    return iso
  }
}

export function PersonClusterCard({
  cluster,
  busy = false,
  onAccept,
  onReject,
  onDefer,
}: PersonClusterCardProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-white border border-sage-200 rounded-lg overflow-hidden shadow-sm">
      <div className="p-4 flex flex-col gap-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-3 flex-wrap">
              <h3 className="text-lg font-serif text-sage-900 truncate">
                {cluster.displayName}
              </h3>
              <span
                className={`inline-flex items-center px-2 py-0.5 text-xs rounded-md border ${scorePillClasses(cluster.aggregateScore)}`}
                title="Aggregate cluster confidence — higher = more certain same-person"
              >
                score {cluster.aggregateScore}
              </span>
              {cluster.llmBridged && (
                <span
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-md border border-purple-200 bg-purple-50 text-purple-700"
                  title={`LLM bridge applied (confidence ${cluster.llmConfidence ?? '?'})`}
                >
                  <Sparkles className="w-3 h-3" />
                  LLM bridged
                </span>
              )}
            </div>
            <div className="mt-1 flex items-center gap-3 text-xs text-sage-500 flex-wrap">
              <span className="flex items-center gap-1">
                <Layers className="w-3 h-3" />
                {cluster.handles.length} handle{cluster.handles.length === 1 ? '' : 's'} · {cluster.totalRecords} record{cluster.totalRecords === 1 ? '' : 's'}
              </span>
              <span className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                first {formatDate(cluster.firstObservedAt)} · last {formatDate(cluster.lastObservedAt)}
              </span>
              {cluster.canonicalPersonId && (
                <span className="font-mono text-sage-400">
                  canonical {cluster.canonicalPersonId.slice(0, 8)}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onAccept?.(cluster.clusterKey)}
              disabled={busy || !onAccept}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-sage-500 text-white rounded-md hover:bg-sage-600 disabled:opacity-50"
              title="Accept cluster — merges all handles atomically"
            >
              <Check className="w-4 h-4" />
              Accept
            </button>
            <button
              type="button"
              onClick={() => onDefer?.(cluster.clusterKey)}
              disabled={busy || !onDefer}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-sage-300 text-sage-700 rounded-md hover:bg-sage-50 disabled:opacity-50"
              title="Defer — sink to bottom for later review"
            >
              <Clock className="w-4 h-4" />
              Defer
            </button>
            <button
              type="button"
              onClick={() => onReject?.(cluster.clusterKey)}
              disabled={busy || !onReject}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm border border-rose-200 text-rose-700 rounded-md hover:bg-rose-50 disabled:opacity-50"
              title="Reject cluster — files as audit, removes from live list"
            >
              <X className="w-4 h-4" />
              Reject
            </button>
          </div>
        </div>

        {/* Per-platform handle chips */}
        <div className="flex flex-wrap gap-1.5">
          {cluster.handles.map((h) => (
            <span
              key={h.handle}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md border bg-sage-50 border-sage-200 text-sage-700"
              title={h.reasoning.join(' · ')}
            >
              <span className="font-mono text-sage-500">{h.platforms.join('/')}:</span>
              <span className="font-mono">{h.handle}</span>
              <span className="text-sage-400">·{h.recordCount}</span>
            </span>
          ))}
        </div>
      </div>

      <div className="border-t border-sage-100 px-4 py-2 flex items-center justify-between text-xs text-sage-600">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-1 hover:text-sage-900"
        >
          {expanded ? (
            <>
              <ChevronUp className="w-3.5 h-3.5" />
              Hide reasoning
            </>
          ) : (
            <>
              <ChevronDown className="w-3.5 h-3.5" />
              Show reasoning
            </>
          )}
        </button>
        <span className="text-sage-400 font-mono text-[10px]">
          key {cluster.clusterKey.length > 40 ? `${cluster.clusterKey.slice(0, 40)}…` : cluster.clusterKey}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-sage-100 bg-sage-50/40 px-4 py-3 space-y-3">
          <div>
            <div className="text-xs font-medium text-sage-800 mb-1">Cluster reasoning</div>
            <ul className="text-xs text-sage-700 space-y-0.5 list-disc list-inside">
              {cluster.reasoning.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="text-xs font-medium text-sage-800 mb-1">Per-handle reasoning</div>
            <ul className="space-y-2">
              {cluster.handles.map((h) => (
                <li key={h.handle} className="text-xs">
                  <div className="font-mono text-sage-900">
                    @{h.handle}{' '}
                    <span className="text-sage-500">
                      ({h.platforms.join(', ')} · score {h.score})
                    </span>
                  </div>
                  <ul className="ml-4 text-sage-600 list-disc list-inside space-y-0.5">
                    {h.reasoning.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
