'use client'

/**
 * /admin/disagreements — disagreement surfacing dashboard (moved
 * from /intel in Round 2 audit TIER 3, 2026-05-14; legacy route
 * redirects via next.config.ts).
 *
 * Anchor docs:
 *   - bloom-constitution.md (Pattern 12: the disagreement IS the gold)
 *   - feedback_self_reported_sources_not_truth.md (the gap between
 *     stated and forensic is exactly the value Bloom delivers vs every
 *     other CRM that just trusts what's typed in)
 *   - feedback_measure_dont_assume.md (don't pre-judge — surface the
 *     gap, operator decides)
 *
 * Layout
 * ------
 * Top: counts by axis (e.g. "23 source disagreements, 8 date drift, 5
 * persona overrides"). Click an axis chip to filter.
 *
 * Filter bar: axis × status × min-magnitude.
 *
 * Body: per-axis sections, each with a list of DisagreementCard
 * components. Top biggest-magnitude active findings highlighted at the
 * very top.
 *
 * "Run detector now" button kicks /api/admin/intel/disagreements/detect
 * for the venue, then refreshes the page.
 */

import { useEffect, useState, useCallback, useMemo } from 'react'
import {
  Loader2,
  RefreshCw,
  AlertTriangle,
  Sparkles,
  Filter as FilterIcon,
} from 'lucide-react'
import { DisagreementCard } from '@/components/intel/DisagreementCard'
import type {
  DisagreementAxis,
  DisagreementFindingRow,
  DisagreementStatus,
  DisagreementSummary,
} from '@/lib/services/disagreement/types'

const AXIS_LABEL: Record<DisagreementAxis, string> = {
  source: 'Source',
  wedding_date: 'Wedding date',
  guest_count: 'Guest count',
  budget: 'Budget',
  persona: 'Persona',
  close_prediction: 'Close prediction',
  name: 'Name',
  crm_source: 'CRM source',
  other: 'Other',
}

const STATUS_LABEL: Record<DisagreementStatus, string> = {
  active: 'Active',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
  investigating: 'Investigating',
}

const STATUSES: DisagreementStatus[] = ['active', 'investigating', 'resolved', 'dismissed']

interface SummaryResp {
  ok: boolean
  summary?: DisagreementSummary
  error?: string
}

interface ListResp {
  ok: boolean
  rows?: DisagreementFindingRow[]
  hasMore?: boolean
  error?: string
}

interface DetectResp {
  ok: boolean
  detect?: {
    scanned: number
    written: number
    refreshed: number
    errors: string[]
  }
  narrate?: {
    narrated: number
    skipped: number
    totalCostCents: number
    errors: string[]
  } | null
  error?: string
}

export default function DisagreementsPage() {
  const [summary, setSummary] = useState<DisagreementSummary | null>(null)
  const [rows, setRows] = useState<DisagreementFindingRow[]>([])
  const [loadingSummary, setLoadingSummary] = useState(true)
  const [loadingRows, setLoadingRows] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [detectBusy, setDetectBusy] = useState(false)
  const [lastDetect, setLastDetect] = useState<DetectResp | null>(null)

  // Filters.
  const [filterAxis, setFilterAxis] = useState<DisagreementAxis | 'all'>('all')
  const [filterStatus, setFilterStatus] = useState<DisagreementStatus>('active')
  const [minMag, setMinMag] = useState<number | null>(null)

  const loadSummary = useCallback(async () => {
    setLoadingSummary(true)
    try {
      const res = await fetch('/api/admin/intel/disagreements/summary')
      const data = (await res.json()) as SummaryResp
      if (!res.ok || !data.ok || !data.summary) {
        setError(data.error ?? 'failed to load summary')
        return
      }
      setSummary(data.summary)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingSummary(false)
    }
  }, [])

  const loadRows = useCallback(async () => {
    setLoadingRows(true)
    try {
      const params = new URLSearchParams()
      if (filterAxis !== 'all') params.set('axis', filterAxis)
      params.set('status', filterStatus)
      if (minMag !== null) params.set('minMagnitude', String(minMag))
      params.set('limit', '200')
      const res = await fetch(`/api/admin/intel/disagreements/list?${params.toString()}`)
      const data = (await res.json()) as ListResp
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'failed to load list')
        return
      }
      setRows(data.rows ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoadingRows(false)
    }
  }, [filterAxis, filterStatus, minMag])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  useEffect(() => {
    loadRows()
  }, [loadRows])

  const runDetect = useCallback(async () => {
    setDetectBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/intel/disagreements/detect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ narrate: true, limit: 200 }),
      })
      const data = (await res.json()) as DetectResp
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'detect failed')
        return
      }
      setLastDetect(data)
      await loadSummary()
      await loadRows()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setDetectBusy(false)
    }
  }, [loadSummary, loadRows])

  const rowsGroupedByAxis = useMemo(() => {
    const map = new Map<DisagreementAxis, DisagreementFindingRow[]>()
    for (const r of rows) {
      const arr = map.get(r.axis) ?? []
      arr.push(r)
      map.set(r.axis, arr)
    }
    return map
  }, [rows])

  return (
    <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-serif text-3xl text-slate-900 mb-1">
            Disagreements
          </h1>
          <p className="text-sm text-slate-600 max-w-2xl">
            When two sources of truth disagree, the disagreement itself is the
            intelligence. Bloom&apos;s memory exceeds the couple&apos;s — the gap
            between &quot;couple says&quot; and &quot;data shows&quot; is exactly the
            value Bloom delivers vs every other CRM that just trusts what&apos;s
            typed in.
          </p>
        </div>
        <button
          onClick={runDetect}
          disabled={detectBusy}
          className="flex items-center gap-2 text-sm font-medium bg-slate-900 text-white px-4 py-2 rounded hover:bg-slate-800 disabled:opacity-50"
        >
          {detectBusy ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Run detector now
        </button>
      </header>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-800 flex items-start gap-2">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {lastDetect?.detect && (
        <div className="bg-emerald-50 border border-emerald-200 rounded p-3 text-sm text-emerald-900 flex items-start gap-2">
          <Sparkles className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <div>
            Detector scanned {lastDetect.detect.scanned} weddings.{' '}
            {lastDetect.detect.written} new disagreement
            {lastDetect.detect.written === 1 ? '' : 's'}, {lastDetect.detect.refreshed} refreshed.
            {lastDetect.narrate && (
              <span>
                {' '}Narrator wrote {lastDetect.narrate.narrated} paragraph
                {lastDetect.narrate.narrated === 1 ? '' : 's'} (cost ~$
                {((lastDetect.narrate.totalCostCents ?? 0) / 100).toFixed(2)}).
              </span>
            )}
            {lastDetect.detect.errors.length > 0 && (
              <span className="block text-emerald-700 mt-1">
                {lastDetect.detect.errors.length} non-fatal warnings.
              </span>
            )}
          </div>
        </div>
      )}

      {/* Axis-count chips */}
      <section className="space-y-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
          By axis
        </h2>
        {loadingSummary ? (
          <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
        ) : !summary ? null : (
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setFilterAxis('all')}
              className={`text-xs px-3 py-1.5 rounded-full border ${
                filterAxis === 'all'
                  ? 'bg-slate-900 text-white border-slate-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'
              }`}
            >
              All ({summary.byAxis.reduce((s, a) => s + a.active, 0)} active)
            </button>
            {summary.byAxis
              .filter((b) => b.total > 0)
              .sort((a, b) => b.active - a.active)
              .map((b) => (
                <button
                  key={b.axis}
                  onClick={() => setFilterAxis(b.axis)}
                  className={`text-xs px-3 py-1.5 rounded-full border ${
                    filterAxis === b.axis
                      ? 'bg-slate-900 text-white border-slate-900'
                      : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'
                  }`}
                >
                  {AXIS_LABEL[b.axis] ?? b.axis} ({b.active}/{b.total})
                </button>
              ))}
          </div>
        )}
      </section>

      {/* Filter bar */}
      <section className="flex items-center gap-3 flex-wrap text-xs">
        <div className="flex items-center gap-1 text-slate-500">
          <FilterIcon className="w-3.5 h-3.5" />
          <span>Status:</span>
        </div>
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`px-2.5 py-1 rounded border ${
              filterStatus === s
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'
            }`}
          >
            {STATUS_LABEL[s]} ({summary?.totals?.[s] ?? 0})
          </button>
        ))}
        <div className="flex items-center gap-1 text-slate-500 ml-2">
          <span>Min magnitude:</span>
        </div>
        {[null, 25, 50, 75].map((m, i) => (
          <button
            key={i}
            onClick={() => setMinMag(m)}
            className={`px-2.5 py-1 rounded border ${
              minMag === m
                ? 'bg-slate-900 text-white border-slate-900'
                : 'bg-white text-slate-700 border-slate-300 hover:border-slate-500'
            }`}
          >
            {m === null ? 'any' : `≥ ${m}`}
          </button>
        ))}
      </section>

      {/* Biggest findings */}
      {filterStatus === 'active' && filterAxis === 'all' && summary && summary.biggest.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Biggest gaps (top {summary.biggest.length})
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {summary.biggest.slice(0, 4).map((f) => (
              <DisagreementCard key={f.id} finding={f} onUpdated={() => {
                loadSummary()
                loadRows()
              }} />
            ))}
          </div>
        </section>
      )}

      {/* Per-axis sections (filtered view) */}
      <section className="space-y-6">
        {loadingRows ? (
          <div className="flex items-center gap-2 text-slate-500 text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading findings...
          </div>
        ) : rows.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded p-8 text-center text-sm text-slate-600">
            No disagreements match this filter.{' '}
            {filterStatus === 'active' && (
              <span>
                When stated values disagree with the forensic reconstruction
                they&apos;ll surface here.
              </span>
            )}
          </div>
        ) : (
          [...rowsGroupedByAxis.entries()].map(([axis, group]) => (
            <div key={axis} className="space-y-3">
              <h2 className="font-medium text-slate-900 flex items-center gap-2">
                {AXIS_LABEL[axis] ?? axis}
                <span className="text-xs text-slate-500 font-normal">
                  {group.length} finding{group.length === 1 ? '' : 's'}
                </span>
              </h2>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {group.map((f) => (
                  <DisagreementCard key={f.id} finding={f} onUpdated={() => {
                    loadSummary()
                    loadRows()
                  }} />
                ))}
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  )
}
