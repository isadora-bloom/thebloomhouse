'use client'

/**
 * Wave 12 — full couple timeline page.
 *
 * Route: /intel/clients/[id]/timeline
 *
 * Header: couple name (reconstructed identity if available) + current
 * lifecycle stage chip + "days in this stage" + total event counts.
 *
 * Body: <CoupleTimeline /> with the merged signal stream.
 *
 * Anchor docs (~/.claude memory/):
 *   - bloom-constitution.md (aggregate ≠ disclose; the timeline never
 *     surfaces sensitive emotional-truth quotes from the forensic
 *     profile — only operational events.)
 *   - bloom-may8-deep-fixes.md (inbox lifecycle filters direction
 *     'inbound' for counting; the timeline shows both directions but
 *     the kind chips let the operator filter.)
 */

import { useCallback, useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft, RefreshCw, Loader2, AlertCircle } from 'lucide-react'
import { CoupleTimeline } from '@/components/intel/CoupleTimeline'
import { LifecycleStageChip } from '@/components/lifecycle/LifecycleStageChip'
import type {
  TimelineEvent,
  TimelineEventKind,
} from '@/lib/services/timeline/build-timeline'

interface TimelineResponse {
  ok: boolean
  events?: TimelineEvent[]
  truncated?: boolean
  countsByKind?: Record<TimelineEventKind, number>
  totalEvents?: number
  scope?: {
    weddingId: string
    venueId: string | null
    currentLifecycleStage: string | null
    currentLifecycleStageSetAt: string | null
  }
  error?: string
}

interface ProfileSlim {
  ok: boolean
  profile?: {
    names?: {
      partner1?: { first?: string | null; last?: string | null } | null
      partner2?: { first?: string | null; last?: string | null } | null
    }
  }
}

function daysAgo(iso: string | null | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000))
}

function formatName(p?: { first?: string | null; last?: string | null } | null): string | null {
  if (!p) return null
  const parts = [p.first, p.last].filter((s) => s && s.trim())
  return parts.length > 0 ? parts.join(' ') : null
}

export default function CoupleTimelinePage() {
  const params = useParams()
  const router = useRouter()
  const weddingId = (params?.id as string) || ''
  const [data, setData] = useState<TimelineResponse | null>(null)
  const [coupleName, setCoupleName] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchTimeline = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/timeline/wedding/${encodeURIComponent(weddingId)}`,
        { cache: 'no-store' },
      )
      const body = (await res.json()) as TimelineResponse
      if (!res.ok || !body.ok) {
        setError(body.error || `HTTP ${res.status}`)
        setData(null)
        return
      }
      setData(body)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'unknown error')
    }
  }, [weddingId])

  const fetchCoupleName = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/admin/identity/reconstruct?weddingId=${encodeURIComponent(weddingId)}`,
        { cache: 'no-store' },
      )
      if (!res.ok) return
      const body = (await res.json()) as ProfileSlim
      const p1 = formatName(body?.profile?.names?.partner1)
      const p2 = formatName(body?.profile?.names?.partner2)
      if (p1 && p2) setCoupleName(`${p1} & ${p2}`)
      else if (p1) setCoupleName(p1)
      else if (p2) setCoupleName(p2)
    } catch {
      // best-effort — header just shows "Couple timeline" in that case
    }
  }, [weddingId])

  useEffect(() => {
    if (!weddingId) {
      setLoading(false)
      return
    }
    setLoading(true)
    Promise.all([fetchTimeline(), fetchCoupleName()]).finally(() => {
      setLoading(false)
    })
  }, [fetchTimeline, fetchCoupleName, weddingId])

  async function refresh() {
    setRefreshing(true)
    try {
      await fetchTimeline()
    } finally {
      setRefreshing(false)
    }
  }

  // ---- Loading state ----
  if (loading) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-surface border border-border rounded-xl p-10 flex items-center gap-3 text-sage-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          Building timeline...
        </div>
      </div>
    )
  }

  // ---- Error state ----
  if (error || !data) {
    return (
      <div className="space-y-6">
        <button
          onClick={() => router.back()}
          className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700"
        >
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <div className="bg-surface border border-rose-200 rounded-xl p-6">
          <div className="flex items-center gap-2 text-rose-700">
            <AlertCircle className="w-4 h-4" />
            <h2 className="font-semibold">Failed to load timeline</h2>
          </div>
          <p className="mt-2 text-sm text-rose-700">{error}</p>
        </div>
      </div>
    )
  }

  const scope = data.scope
  const counts = data.countsByKind ?? ({} as Record<TimelineEventKind, number>)
  const totals = {
    interactions: counts.interaction ?? 0,
    tours: counts.tour ?? 0,
    reviews: counts.review ?? 0,
    lifecycle: counts.lifecycle_transition ?? 0,
    payments: counts.payment ?? 0,
    contracts: counts.contract ?? 0,
    intelMatches: counts.intel_match ?? 0,
    attribution: counts.attribution_event ?? 0,
  }
  const daysInStage = daysAgo(scope?.currentLifecycleStageSetAt)

  return (
    <div className="space-y-6">
      {/* Back link. */}
      <button
        onClick={() => router.back()}
        className="flex items-center gap-2 text-sm text-sage-500 hover:text-sage-700 transition-colors"
      >
        <ArrowLeft className="w-4 h-4" /> Back to lead
      </button>

      {/* Header. */}
      <div className="bg-surface border border-border rounded-xl px-6 py-5">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-heading text-2xl font-bold text-sage-900">
              {coupleName || 'Couple timeline'}
            </h1>
            <p className="text-sm text-sage-500 mt-0.5">
              Every signal we have for this couple, chronologically.
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <LifecycleStageChip
                stage={scope?.currentLifecycleStage}
                variant="pill"
              />
              {daysInStage !== null && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-sage-50 text-sage-700 border border-sage-100">
                  {daysInStage} day{daysInStage === 1 ? '' : 's'} in this stage
                </span>
              )}
              {data.truncated && (
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-amber-50 text-amber-700 border border-amber-200">
                  truncated (capped at 500 events)
                </span>
              )}
            </div>
          </div>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="shrink-0 inline-flex items-center gap-2 px-3 py-1.5 text-sm border border-sage-200 text-sage-700 rounded-md hover:bg-sage-50 disabled:opacity-50"
          >
            {refreshing ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </button>
        </div>

        {/* Inline count summary. */}
        <div className="mt-4 flex items-center flex-wrap gap-x-4 gap-y-1 text-xs text-sage-600">
          <span>{totals.interactions} interactions</span>
          <span>·</span>
          <span>{totals.tours} tours</span>
          <span>·</span>
          <span>{totals.lifecycle} lifecycle transitions</span>
          <span>·</span>
          <span>{totals.payments} payments</span>
          <span>·</span>
          <span>{totals.contracts} contracts</span>
          <span>·</span>
          <span>{totals.reviews} reviews</span>
          <span>·</span>
          <span>{totals.attribution} attribution events</span>
          <span>·</span>
          <span>{totals.intelMatches} intel matches</span>
          {typeof data.totalEvents === 'number' && (
            <>
              <span>·</span>
              <span className="text-sage-400">{data.totalEvents} total</span>
            </>
          )}
        </div>
      </div>

      {/* Timeline body. */}
      <CoupleTimeline
        events={data.events ?? []}
        truncated={data.truncated}
        countsByKind={data.countsByKind}
      />
    </div>
  )
}
