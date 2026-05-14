'use client'

/**
 * Identity-First Phase A: divergence dashboard.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §8 (Phase A) + Appendix B
 * stop condition #1 — "Phase A merged without divergence dashboard.
 * Stop. Build it." This is the build.
 *
 * What it shows
 * -------------
 * Per-venue comparison of weddings_total vs couples_mirrored. Any gap
 * means the dual-write hook in mintWedding (or the backfill in
 * migration 346) missed a wedding. drift_pct > 5% trips alert state
 * and surfaces in red. The page also shows identity-quality counts
 * on the couples side (rows with email vs rows with placeholder
 * '(Unknown — backfilled...)' names) so Phase B Tracer has a baseline
 * to improve against.
 *
 * Read-only. Super-admin or venue-owner only (auth is enforced server-
 * side by GET /api/admin/identity-divergence).
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, RefreshCw, Database } from 'lucide-react'

interface VenueDivergence {
  venue_id: string
  venue_name: string | null
  weddings_total: number
  couples_mirrored: number
  drift_count: number
  drift_pct: number
  alerting: boolean
  couples_with_email: number
  couples_placeholder_name: number
}

interface DivergenceResponse {
  scope: { super_admin: boolean; venue_id: string | null }
  alert_threshold_pct: number
  generated_at: string
  per_venue: VenueDivergence[]
  totals: {
    venues: number
    weddings_total: number
    couples_mirrored: number
    drift_count: number
    drift_pct: number
    alerting_venues: number
  }
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`
}

export default function IdentityDivergencePage() {
  const [data, setData] = useState<DivergenceResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/identity-divergence')
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        setData(null)
      } else {
        setData((await res.json()) as DivergenceResponse)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="font-serif text-3xl text-stone-900">
            Identity-First divergence
          </h1>
          <p className="mt-2 text-sm text-stone-600">
            Phase A drift check: weddings vs mirrored couples. Drift &gt;{' '}
            {data ? pct(data.alert_threshold_pct) : '5.0%'} trips the alert.
            Doctrine anchor: <code>IDENTITY-FIRST-ARCHITECTURE.md</code> §8.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="flex items-center gap-2 rounded-md border border-stone-300 bg-white px-4 py-2 text-sm hover:bg-stone-50 disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div className="mb-6 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <strong>Error:</strong> {error}
        </div>
      )}

      {data && (
        <>
          <div className="mb-8 grid grid-cols-1 gap-4 md:grid-cols-4">
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-stone-500">
                <Database className="h-3.5 w-3.5" />
                Weddings
              </div>
              <div className="mt-1 text-2xl font-medium text-stone-900">
                {data.totals.weddings_total.toLocaleString()}
              </div>
            </div>
            <div className="rounded-lg border border-stone-200 bg-white p-4">
              <div className="text-xs uppercase tracking-wide text-stone-500">
                Couples mirrored
              </div>
              <div className="mt-1 text-2xl font-medium text-stone-900">
                {data.totals.couples_mirrored.toLocaleString()}
              </div>
            </div>
            <div
              className={`rounded-lg border p-4 ${
                data.totals.drift_pct > data.alert_threshold_pct
                  ? 'border-red-300 bg-red-50'
                  : 'border-stone-200 bg-white'
              }`}
            >
              <div className="text-xs uppercase tracking-wide text-stone-500">
                Drift
              </div>
              <div className="mt-1 text-2xl font-medium text-stone-900">
                {pct(data.totals.drift_pct)}
              </div>
              <div className="text-xs text-stone-500">
                {data.totals.drift_count.toLocaleString()} rows
              </div>
            </div>
            <div
              className={`rounded-lg border p-4 ${
                data.totals.alerting_venues > 0
                  ? 'border-red-300 bg-red-50'
                  : 'border-emerald-300 bg-emerald-50'
              }`}
            >
              <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-stone-500">
                {data.totals.alerting_venues > 0 ? (
                  <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                )}
                Alerting venues
              </div>
              <div className="mt-1 text-2xl font-medium text-stone-900">
                {data.totals.alerting_venues}
              </div>
              <div className="text-xs text-stone-500">
                of {data.totals.venues}
              </div>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            <table className="w-full text-sm">
              <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-600">
                <tr>
                  <th className="px-4 py-3">Venue</th>
                  <th className="px-4 py-3 text-right">Weddings</th>
                  <th className="px-4 py-3 text-right">Couples</th>
                  <th className="px-4 py-3 text-right">Drift</th>
                  <th className="px-4 py-3 text-right">Email</th>
                  <th className="px-4 py-3 text-right">Placeholder name</th>
                </tr>
              </thead>
              <tbody>
                {data.per_venue.map((v) => (
                  <tr
                    key={v.venue_id}
                    className={`border-t border-stone-100 ${
                      v.alerting ? 'bg-red-50' : ''
                    }`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-stone-900">
                        {v.venue_name ?? '(unnamed)'}
                      </div>
                      <div className="text-xs text-stone-400">
                        {v.venue_id}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {v.weddings_total.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {v.couples_mirrored.toLocaleString()}
                    </td>
                    <td
                      className={`px-4 py-3 text-right tabular-nums ${
                        v.alerting ? 'font-medium text-red-700' : 'text-stone-600'
                      }`}
                    >
                      <div>{pct(v.drift_pct)}</div>
                      <div className="text-xs text-stone-400">
                        {v.drift_count}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-stone-600">
                      {v.couples_with_email.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-stone-600">
                      {v.couples_placeholder_name.toLocaleString()}
                    </td>
                  </tr>
                ))}
                {data.per_venue.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-4 py-12 text-center text-sm text-stone-500"
                    >
                      No venues in scope.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <p className="mt-4 text-xs text-stone-500">
            Generated {new Date(data.generated_at).toLocaleString()}. Drift
            counts only weddings without a matching{' '}
            <code>couples.source_wedding_id</code>. Placeholder names get
            cleaned up by Phase B Tracer as signatures supply real ones.
          </p>
        </>
      )}
    </div>
  )
}
