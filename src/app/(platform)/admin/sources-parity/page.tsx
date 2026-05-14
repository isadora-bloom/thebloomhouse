'use client'

/**
 * Attribution-parity dashboard (T5-Rixey-BBB / BBB-4).
 *
 * Coordinator-facing dashboard that shows the side-by-side parity
 * between the legacy 7-tier chain output and the new identity-cluster
 * compute output. Reads from `attribution_parity_log` (written daily
 * by the `compute_attribution_parity` cron).
 *
 * Cutover gate
 * ------------
 * Per the cutover playbook, USE_CLUSTER_FIRST_TOUCH flips ON only
 * when this dashboard shows >=90% agreement for 7 consecutive days
 * AND CCC has been running for >=48h. The header banner surfaces
 * the rolling-7-day agreement so the cutover decision is one
 * glance, not a query.
 *
 * Three views
 * -----------
 *   - Agreement-rate timeline (last 30 days)
 *   - Top divergent rows (where chain picks one, cluster picks
 *     another — the highest-stakes coordinator-review entries)
 *   - Both-NULL audit (no signal in either model — these are the
 *     "Untracked" leads the cluster compute would also drop)
 */

import { useEffect, useMemo, useState, useCallback } from 'react'
import { useScope } from '@/lib/hooks/use-scope'
import { createClient } from '@/lib/supabase/client'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts'
import { formatSourceLabel } from '@/lib/utils/format-source-label'
import { AlertTriangle, CheckCircle2, GitCompare } from 'lucide-react'
import Link from 'next/link'

interface ParityRow {
  id: string
  venue_id: string
  wedding_id: string
  chain_source: string | null
  cluster_source: string | null
  agree: boolean
  detail: Record<string, unknown> | null
  computed_at: string
}

interface DailyAgreement {
  day: string                  // 'YYYY-MM-DD'
  scanned: number
  agreed: number
  disagreed: number
  bothNull: number
  agreementPct: number
}



export default function AttributionParityPage() {
  const scope = useScope()
  const [rows, setRows] = useState<ParityRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    if (scope.loading) return
    if (scope.level !== 'venue' || !scope.venueId) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const supabase = createClient()
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data, error: queryErr } = await supabase
        .from('attribution_parity_log')
        .select('id, venue_id, wedding_id, chain_source, cluster_source, agree, detail, computed_at')
        .eq('venue_id', scope.venueId)
        .gte('computed_at', cutoff)
        .order('computed_at', { ascending: false })
        .limit(20000)
      if (queryErr) {
        setError(queryErr.message)
        setRows([])
      } else {
        setRows((data ?? []) as ParityRow[])
      }
    } finally {
      setLoading(false)
    }
  }, [scope.loading, scope.level, scope.venueId])

  useEffect(() => { fetchData() }, [fetchData])

  // ---- Aggregations ----

  const dailyAgreement: DailyAgreement[] = useMemo(() => {
    const byDay = new Map<string, { scanned: number; agreed: number; disagreed: number; bothNull: number }>()
    for (const r of rows) {
      const day = r.computed_at.slice(0, 10)
      const b = byDay.get(day) ?? { scanned: 0, agreed: 0, disagreed: 0, bothNull: 0 }
      b.scanned++
      if (r.chain_source === null && r.cluster_source === null) b.bothNull++
      else if (r.agree) b.agreed++
      else b.disagreed++
      byDay.set(day, b)
    }
    return Array.from(byDay.entries())
      .map(([day, b]) => ({
        day,
        ...b,
        agreementPct: b.scanned > 0 ? Math.round((100 * (b.agreed + b.bothNull)) / b.scanned) : 0,
      }))
      .sort((a, b) => a.day.localeCompare(b.day))
  }, [rows])

  /** Latest-run aggregate (most recent computed_at). */
  const latestRun = useMemo(() => {
    if (rows.length === 0) return null
    const latestTs = rows[0]!.computed_at.slice(0, 10)
    return dailyAgreement.find((d) => d.day === latestTs) ?? null
  }, [rows, dailyAgreement])

  /** Rolling-7-day agreement rate — the cutover gate. */
  const rolling7DayAgreement = useMemo(() => {
    if (dailyAgreement.length === 0) return null
    const last7 = dailyAgreement.slice(-7)
    const totalScanned = last7.reduce((acc, d) => acc + d.scanned, 0)
    const totalAgreed = last7.reduce((acc, d) => acc + d.agreed + d.bothNull, 0)
    if (totalScanned === 0) return null
    const pct = Math.round((100 * totalAgreed) / totalScanned)
    const allMeetGate = last7.length >= 7 && last7.every((d) => d.agreementPct >= 90)
    return { pct, days: last7.length, allMeetGate }
  }, [dailyAgreement])

  /** Top divergent rows — where chain and cluster disagree on a real
   *  channel (excluding both-null + chain-null + cluster-null cases).
   *  Use the latest run only so coordinators see the current state. */
  const topDivergences = useMemo(() => {
    if (rows.length === 0) return []
    const latestTs = rows[0]!.computed_at.slice(0, 10)
    return rows
      .filter((r) => r.computed_at.slice(0, 10) === latestTs && !r.agree
        && r.chain_source !== null && r.cluster_source !== null)
      .slice(0, 50)
  }, [rows])

  /** Pair frequency: chain → cluster. Pattern detection. */
  const divergencePairs = useMemo(() => {
    if (rows.length === 0) return []
    const latestTs = rows[0]!.computed_at.slice(0, 10)
    const counts = new Map<string, number>()
    for (const r of rows) {
      if (r.computed_at.slice(0, 10) !== latestTs) continue
      if (r.agree) continue
      const k = `${r.chain_source ?? '(null)'} → ${r.cluster_source ?? '(null)'}`
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([pair, count]) => ({ pair, count }))
  }, [rows])

  if (scope.level !== 'venue' || !scope.venueId) {
    return (
      <div className="p-8">
        <h1 className="text-2xl font-serif text-slate-900 mb-2">Attribution parity</h1>
        <p className="text-slate-600 text-sm">
          Pick a single venue from the venue selector to see the parity
          dashboard. Aggregating across venues hides per-venue divergence
          patterns.
        </p>
      </div>
    )
  }

  return (
    <div className="p-8 max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-3xl font-serif text-slate-900 mb-2 flex items-center gap-3">
            <GitCompare className="w-7 h-7 text-sage-700" />
            Attribution parity
          </h1>
          <p className="text-slate-600 text-sm max-w-2xl">
            Side-by-side comparison of the legacy 7-tier chain (today) versus
            the new identity-cluster compute. The cutover happens after this
            dashboard shows ≥90% agreement for 7 consecutive days.{' '}
            <Link href="/intel/sources" className="text-sage-700 underline">
              ← Back to Sources
            </Link>
          </p>
        </div>
        {rolling7DayAgreement && (
          <div className={`px-4 py-3 rounded-lg border ${rolling7DayAgreement.allMeetGate ? 'bg-green-50 border-green-200' : 'bg-amber-50 border-amber-200'}`}>
            <div className="text-xs uppercase tracking-wide text-slate-600">Rolling 7-day</div>
            <div className="text-2xl font-mono font-semibold text-slate-900">
              {rolling7DayAgreement.pct}%
            </div>
            <div className="text-xs text-slate-600 flex items-center gap-1 mt-1">
              {rolling7DayAgreement.allMeetGate ? (
                <>
                  <CheckCircle2 className="w-3 h-3 text-green-600" />
                  Cutover gate cleared
                </>
              ) : (
                <>
                  <AlertTriangle className="w-3 h-3 text-amber-600" />
                  Below 90% gate
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Latest run summary */}
      {latestRun && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Latest scan</div>
            <div className="text-lg font-mono text-slate-900">{latestRun.day}</div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Weddings scanned</div>
            <div className="text-lg font-mono text-slate-900">{latestRun.scanned}</div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Agreed</div>
            <div className="text-lg font-mono text-green-700">{latestRun.agreed}</div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Disagreed</div>
            <div className="text-lg font-mono text-amber-700">{latestRun.disagreed}</div>
          </div>
          <div className="bg-white rounded-lg border border-slate-200 p-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">Both NULL</div>
            <div className="text-lg font-mono text-slate-700">{latestRun.bothNull}</div>
          </div>
        </div>
      )}

      {/* Agreement-rate timeline */}
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <h2 className="text-lg font-serif text-slate-900 mb-1">Agreement rate (last 30 days)</h2>
        <p className="text-sm text-slate-600 mb-4">
          Each point is one daily parity scan. The 90% reference line is the
          cutover gate; the cluster compute needs to clear that for 7 days
          straight before USE_CLUSTER_FIRST_TOUCH flips ON.
        </p>
        {loading ? (
          <div className="h-64 flex items-center justify-center text-slate-400">Loading…</div>
        ) : error ? (
          <div className="h-64 flex items-center justify-center text-red-600 text-sm">{error}</div>
        ) : dailyAgreement.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-slate-400 text-sm">
            No parity scans yet. The cron runs at 05:00 UTC daily; check back tomorrow.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={dailyAgreement}>
              <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
              <XAxis dataKey="day" tick={{ fill: '#64748b', fontSize: 12 }} />
              <YAxis domain={[0, 100]} tick={{ fill: '#64748b', fontSize: 12 }}
                label={{ value: '% agree', angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 12 }} />
              <Tooltip />
              <ReferenceLine y={90} stroke="#16a34a" strokeDasharray="3 3" label={{ value: '90% gate', position: 'right', fill: '#16a34a', fontSize: 11 }} />
              <Line type="monotone" dataKey="agreementPct" stroke="#7D8471" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Divergence pairs */}
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <h2 className="text-lg font-serif text-slate-900 mb-1">Top divergent pairs (latest scan)</h2>
        <p className="text-sm text-slate-600 mb-4">
          Each row shows how often the chain → cluster swap appears.
          Repeated pairs (e.g. <code className="text-xs bg-slate-100 px-1 rounded">website → the_knot</code>)
          indicate where the cluster reliably finds an upstream source the
          chain hides behind a touchpoint bucket.
        </p>
        {divergencePairs.length === 0 ? (
          <div className="text-slate-500 text-sm">No divergences in latest scan.</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="min-w-[400px] w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200 text-slate-600">
                <th className="py-2 font-medium">Chain (current)</th>
                <th className="py-2 font-medium">Cluster (proposed)</th>
                <th className="py-2 font-medium text-right">Weddings</th>
              </tr>
            </thead>
            <tbody>
              {divergencePairs.map((p) => {
                const [left, right] = p.pair.split(' → ')
                return (
                  <tr key={p.pair} className="border-b border-slate-100">
                    <td className="py-2 text-slate-900">{left === '(null)' ? <span className="text-slate-400">—</span> : formatSourceLabel(left ?? null)}</td>
                    <td className="py-2 text-slate-900">{right === '(null)' ? <span className="text-slate-400">—</span> : formatSourceLabel(right ?? null)}</td>
                    <td className="py-2 text-right font-mono">{p.count}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      {/* Per-row drill-down (latest scan) */}
      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <h2 className="text-lg font-serif text-slate-900 mb-1">Divergent leads (latest scan)</h2>
        <p className="text-sm text-slate-600 mb-4">
          The top 50 weddings where chain and cluster pick different real
          channels. Click through to lead detail to inspect signals.
        </p>
        {topDivergences.length === 0 ? (
          <div className="text-slate-500 text-sm">No real-source divergences in latest scan.</div>
        ) : (
          <div className="overflow-x-auto">
          <table className="min-w-[640px] w-full text-sm">
            <thead>
              <tr className="text-left border-b border-slate-200 text-slate-600">
                <th className="py-2 font-medium">Wedding</th>
                <th className="py-2 font-medium">Chain</th>
                <th className="py-2 font-medium">Cluster</th>
                <th className="py-2 font-medium">Cluster confidence</th>
                <th className="py-2 font-medium">Signals</th>
              </tr>
            </thead>
            <tbody>
              {topDivergences.map((r) => {
                const detail = (r.detail ?? {}) as { cluster_confidence?: string; cluster_total_signals?: number; cluster_total_source_signals?: number }
                return (
                  <tr key={r.id} className="border-b border-slate-100">
                    <td className="py-2">
                      <Link href={`/agent/leads/${r.wedding_id}`} className="text-sage-700 hover:underline font-mono text-xs">
                        {r.wedding_id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="py-2">{formatSourceLabel(r.chain_source)}</td>
                    <td className="py-2">{formatSourceLabel(r.cluster_source)}</td>
                    <td className="py-2 text-xs uppercase">{detail.cluster_confidence ?? '—'}</td>
                    <td className="py-2 text-xs text-slate-600">
                      {detail.cluster_total_source_signals ?? 0} source / {detail.cluster_total_signals ?? 0} total
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>
        )}
      </div>

      <div className="text-xs text-slate-500 mt-8">
        Cutover gate: USE_CLUSTER_FIRST_TOUCH=true once 7 consecutive days
        ≥90% agreement AND CCC backtrack has been running ≥48h. See
        <code className="bg-slate-100 px-1 mx-1 rounded">audits/2026-05-T4-postlaunch/identity-cluster-attribution-design.md</code>
        for the full design.
      </div>
    </div>
  )
}
