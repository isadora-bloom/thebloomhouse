'use client'

/**
 * Identity-system telemetry dashboard.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §9. Isadora-visible only
 * (super_admin / org_admin); per-venue auto-promotion rate, operator
 * rejection rate, open queue depth, judge load. Trends here are the
 * early signal that the matcher is over-merging (rejection rate
 * climbing) or under-firing (auto-promotion rate falling).
 */

import { useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Gauge,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'

interface VenueRow {
  venue_id: string
  venue_name: string
  couples: {
    total: number
    booked: number
    resolved: number
    channel_scoped: number
    ghost: number
    agent: number
  }
  candidates: {
    open: number
    confirmed: number
    rejected: number
    not_sure: number
    total: number
  }
  auto_promotion_rate: number
  rejection_rate: number
  open_queue_depth: number
  judge_calls_24h: number
  last_decay_sweep: {
    latest: string
    ghosted: number
    examined: number
  } | null
}

const REJECTION_ALERT_THRESHOLD = 0.1
const AUTO_PROMOTION_FLOOR = 0.4

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

export default function IdentityTelemetryPage() {
  const [rows, setRows] = useState<VenueRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [window, setWindow] = useState(30)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/identity-telemetry')
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        setRows([])
        return
      }
      const data = (await res.json()) as {
        window_days: number
        venues: VenueRow[]
      }
      setRows(data.venues)
      setWindow(data.window_days)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  return (
    <div className="mx-auto max-w-7xl p-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Gauge className="h-5 w-5 text-stone-500" />
            <h1 className="font-serif text-3xl text-stone-900">
              Identity telemetry
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm text-stone-600">
            Cross-venue health of the identity reconstruction loop. Window:
            last {window} days. Rejection rate climbing above{' '}
            {pct(REJECTION_ALERT_THRESHOLD)} flags the matcher as
            over-merging; auto-promotion rate below {pct(AUTO_PROMOTION_FLOOR)}{' '}
            usually means under-firing.
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm hover:bg-stone-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <strong>Error:</strong> {error}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-600">
            <tr>
              <th className="px-4 py-3">Venue</th>
              <th className="px-4 py-3 text-right">Couples</th>
              <th className="px-4 py-3 text-right">Booked</th>
              <th className="px-4 py-3 text-right">Ghost</th>
              <th className="px-4 py-3 text-right">Open queue</th>
              <th className="px-4 py-3 text-right">Auto-promote</th>
              <th className="px-4 py-3 text-right">Reject rate</th>
              <th className="px-4 py-3 text-right">Judge 24h</th>
              <th className="px-4 py-3">Last decay</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-12 text-center text-sm text-stone-500"
                >
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-stone-400" />
                </td>
              </tr>
            )}
            {!loading && rows.length === 0 && (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-12 text-center text-sm text-stone-500"
                >
                  No data yet.
                </td>
              </tr>
            )}
            {!loading &&
              rows.map((r) => {
                const rejectAlert = r.rejection_rate >= REJECTION_ALERT_THRESHOLD
                const autoAlert =
                  r.candidates.total > 25 &&
                  r.auto_promotion_rate < AUTO_PROMOTION_FLOOR
                return (
                  <tr key={r.venue_id} className="border-t border-stone-100">
                    <td className="px-4 py-3 font-medium text-stone-900">
                      {r.venue_name}
                    </td>
                    <td className="px-4 py-3 text-right text-stone-700 tabular-nums">
                      {r.couples.total.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-emerald-700 tabular-nums">
                      {r.couples.booked.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right text-stone-500 tabular-nums">
                      {r.couples.ghost.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span
                        className={
                          r.open_queue_depth > 0
                            ? 'inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800'
                            : 'text-stone-500'
                        }
                      >
                        {r.open_queue_depth.toLocaleString()}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span
                        className={
                          autoAlert
                            ? 'inline-flex items-center gap-1 text-orange-800'
                            : 'text-stone-700'
                        }
                      >
                        {autoAlert && <ArrowDown className="h-3 w-3" />}
                        {pct(r.auto_promotion_rate)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      <span
                        className={
                          rejectAlert
                            ? 'inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800'
                            : 'text-stone-700'
                        }
                      >
                        {rejectAlert && <ShieldAlert className="h-3 w-3" />}
                        {pct(r.rejection_rate)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-stone-700 tabular-nums">
                      {r.judge_calls_24h.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-xs text-stone-500">
                      {r.last_decay_sweep ? (
                        <>
                          {new Date(r.last_decay_sweep.latest).toLocaleDateString()}{' '}
                          <span className="text-stone-400">
                            ({r.last_decay_sweep.ghosted}/{r.last_decay_sweep.examined} ghosted)
                          </span>
                        </>
                      ) : (
                        <span className="text-stone-400">never</span>
                      )}
                    </td>
                  </tr>
                )
              })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 text-xs text-stone-500 md:grid-cols-2">
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
          <div className="flex items-center gap-1 font-medium text-stone-700">
            <ArrowUp className="h-3 w-3" /> Auto-promotion rate
          </div>
          High-tier matcher hits as a share of total candidate proposals.
          Dropping below {pct(AUTO_PROMOTION_FLOOR)} on a venue with
          meaningful traffic usually means the matcher is under-firing,
          likely from missing identifier signals.
        </div>
        <div className="rounded-md border border-stone-200 bg-stone-50 p-3">
          <div className="flex items-center gap-1 font-medium text-stone-700">
            <ShieldAlert className="h-3 w-3" /> Rejection rate
          </div>
          Rate of operator-rejected resolutions out of resolved candidates.
          Above {pct(REJECTION_ALERT_THRESHOLD)}: matcher is over-merging
          and needs calibration.
        </div>
      </div>
    </div>
  )
}
