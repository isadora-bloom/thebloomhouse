'use client'

/**
 * DiscoveryFeedbackPanel — Wave 7D embeddable feedback-actions log.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7D closes the discovery loop)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7D spec)
 *
 * What this shows
 * ---------------
 * For one discovery, the audit trail of every Wave 5/6 feedback write
 * (target_system + action_type + payload summary). Reusable: drop into
 * a discovery card, the per-discovery detail page, or a coordinator
 * sidebar.
 *
 * Aggregate ≠ disclose: the payloads we render are anonymised — channel
 * labels, persona labels, counts. We never render couple identifiers.
 */

import { useEffect, useState, useCallback } from 'react'
import {
  Loader2,
  AlertCircle,
  CheckCircle2,
  Database,
  Tag as TagIcon,
  Flag as FlagIcon,
  ListPlus,
  XCircle,
} from 'lucide-react'

interface FeedbackActionRow {
  id: string
  discovery_id: string
  venue_id: string
  target_system: string
  action_type: string
  payload: Record<string, unknown> | null
  written_at: string
  error: string | null
}

interface FeedbackActionsResponse {
  ok: boolean
  discoveryId?: string
  venueId?: string
  actions?: FeedbackActionRow[]
  error?: string
}

function actionIcon(actionType: string) {
  if (actionType === 'enqueue') return <ListPlus className="w-3.5 h-3.5" />
  if (actionType === 'upsert') return <Database className="w-3.5 h-3.5" />
  if (actionType === 'tag') return <TagIcon className="w-3.5 h-3.5" />
  if (actionType === 'flag') return <FlagIcon className="w-3.5 h-3.5" />
  return <Database className="w-3.5 h-3.5" />
}

function relativeTime(iso: string): string {
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

function summarisePayload(payload: Record<string, unknown> | null): string {
  if (!payload || typeof payload !== 'object') return ''
  const parts: string[] = []
  // Cherry-pick the top fields so the summary stays scannable.
  const candidates: Array<[string, string]> = [
    ['channel', 'channel'],
    ['vendor_name', 'vendor'],
    ['persona_label', 'persona'],
    ['competitor_name', 'competitor'],
    ['cohort_segment', 'cohort'],
    ['jobs_enqueued', 'jobs'],
    ['candidates_considered', 'candidates'],
    ['total_patterns', 'patterns'],
  ]
  for (const [key, label] of candidates) {
    const val = (payload as Record<string, unknown>)[key]
    if (typeof val === 'string' && val.length > 0) parts.push(`${label}=${val}`)
    else if (typeof val === 'number') parts.push(`${label}=${val}`)
  }
  return parts.join(' · ')
}

export interface DiscoveryFeedbackPanelProps {
  discoveryId: string
  /** When supplied, render in a "compact" row (no surrounding card chrome). */
  compact?: boolean
}

export function DiscoveryFeedbackPanel({
  discoveryId,
  compact,
}: DiscoveryFeedbackPanelProps) {
  const [actions, setActions] = useState<FeedbackActionRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchActions = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/intel/discoveries/${discoveryId}/feedback-actions`,
        { cache: 'no-store' },
      )
      const body = (await res.json()) as FeedbackActionsResponse
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        setActions(null)
        return
      }
      setActions(body.actions ?? [])
      setError(null)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error'
      setError(msg)
    }
  }, [discoveryId])

  useEffect(() => {
    setLoading(true)
    fetchActions().finally(() => setLoading(false))
  }, [fetchActions])

  if (loading) {
    return (
      <div className={compact ? '' : 'bg-surface border border-border rounded-lg p-4'}>
        <div className="flex items-center gap-2 text-xs text-sage-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          Loading feedback actions...
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={compact ? '' : 'bg-surface border border-border rounded-lg p-4'}>
        <div className="flex items-center gap-2 text-xs text-rose-700">
          <AlertCircle className="w-3.5 h-3.5" />
          {error}
        </div>
      </div>
    )
  }

  if (!actions || actions.length === 0) {
    return (
      <div className={compact ? '' : 'bg-surface border border-border rounded-lg p-4'}>
        <div className="text-xs text-sage-500">No feedback actions recorded yet.</div>
      </div>
    )
  }

  return (
    <div className={compact ? '' : 'bg-surface border border-border rounded-lg p-4'}>
      {!compact && (
        <div className="text-[11px] font-medium text-sage-700 uppercase tracking-wide mb-2">
          Feedback actions ({actions.length})
        </div>
      )}
      <ul className="space-y-1.5">
        {actions.map((a) => (
          <li
            key={a.id}
            className="flex items-start gap-2 text-xs text-sage-700"
          >
            <span
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border ${
                a.error
                  ? 'bg-rose-50 border-rose-200 text-rose-700'
                  : 'bg-sage-50 border-sage-200 text-sage-700'
              }`}
            >
              {a.error ? <XCircle className="w-3.5 h-3.5" /> : actionIcon(a.action_type)}
              <span>{a.action_type}</span>
            </span>
            <span className="font-mono text-[11px] text-sage-600">
              {a.target_system}
            </span>
            {a.payload && (
              <span className="text-sage-500 text-[11px]">
                {summarisePayload(a.payload)}
              </span>
            )}
            <span className="ml-auto text-[10px] text-sage-400">
              {relativeTime(a.written_at)}
            </span>
            {!a.error && (
              <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0 mt-0.5" />
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export default DiscoveryFeedbackPanel
