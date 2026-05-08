'use client'

/**
 * /super-admin/observability — Tier-D bucket 2 sweep.
 *
 * cron_runs and metered_events have been heavily written for months
 * but never surfaced. This page renders:
 *
 *   - Recent cron runs (last 200) with status, duration, error
 *   - Cron failure rate by name over the last 7 days
 *   - Metered counters rolled up to the last 24h
 *
 * Super-admin only. The data is platform-wide so the scope cookie is
 * irrelevant; we render the org-agnostic view.
 */

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import {
  ArrowLeft,
  Loader2,
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Gauge,
} from 'lucide-react'

interface CronRun {
  id: string
  cron_name: string
  status: 'running' | 'success' | 'partial' | 'failure' | 'timeout'
  started_at: string
  ended_at: string | null
  duration_ms: number | null
  rows_processed: number | null
  error_message: string | null
  error_class: string | null
}

interface MeterRow {
  counter_name: string
  count: number
  sum_value: number
  recent_value: number
}

function statusStyle(s: CronRun['status']) {
  switch (s) {
    case 'success':
      return { Icon: CheckCircle, color: 'text-emerald-600', bg: 'bg-emerald-50' }
    case 'running':
      return { Icon: Clock, color: 'text-sage-600', bg: 'bg-sage-50' }
    case 'partial':
      return { Icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50' }
    case 'failure':
    case 'timeout':
      return { Icon: AlertTriangle, color: 'text-rose-600', bg: 'bg-rose-50' }
  }
}

function fmtDuration(ms: number | null): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60_000).toFixed(1)}min`
}

export default function ObservabilityPage() {
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [runs, setRuns] = useState<CronRun[]>([])
  const [meters, setMeters] = useState<MeterRow[]>([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const supabase = createClient()
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

        const [runsRes, metersRes] = await Promise.all([
          supabase
            .from('cron_runs')
            .select('id, cron_name, status, started_at, ended_at, duration_ms, rows_processed, error_message, error_class')
            .gte('started_at', sevenDaysAgo)
            .order('started_at', { ascending: false })
            .limit(200),
          supabase
            .from('metered_events')
            .select('counter_name, value')
            .gte('observed_at', oneDayAgo)
            .limit(20_000),
        ])

        if (runsRes.error) throw runsRes.error
        if (metersRes.error) throw metersRes.error

        if (!cancelled) {
          setRuns((runsRes.data ?? []) as CronRun[])

          // Bucket metered_events by counter_name.
          const bucket = new Map<string, { count: number; sum: number; recent: number }>()
          for (const r of (metersRes.data ?? []) as Array<{ counter_name: string; value: number }>) {
            const b = bucket.get(r.counter_name) ?? { count: 0, sum: 0, recent: 0 }
            b.count += 1
            b.sum += Number(r.value) || 0
            b.recent = Number(r.value) || 0
            bucket.set(r.counter_name, b)
          }
          const meterRows: MeterRow[] = Array.from(bucket.entries())
            .map(([name, b]) => ({
              counter_name: name,
              count: b.count,
              sum_value: b.sum,
              recent_value: b.recent,
            }))
            .sort((a, b) => b.count - a.count)
          setMeters(meterRows)
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [])

  if (loading) {
    return (
      <div className="flex items-center justify-center p-16">
        <Loader2 className="w-6 h-6 animate-spin text-sage-400" />
      </div>
    )
  }

  if (err) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-lg text-sm text-rose-700">
          Could not load observability data: {err}
        </div>
      </div>
    )
  }

  // Cron failure rate by name over the 7-day window.
  const byName = new Map<string, { total: number; failed: number; lastRun: string | null }>()
  for (const r of runs) {
    const b = byName.get(r.cron_name) ?? { total: 0, failed: 0, lastRun: null }
    b.total += 1
    if (r.status === 'failure' || r.status === 'timeout') b.failed += 1
    if (!b.lastRun || r.started_at > b.lastRun) b.lastRun = r.started_at
    byName.set(r.cron_name, b)
  }
  const cronSummary = Array.from(byName.entries())
    .map(([name, b]) => ({
      name,
      total: b.total,
      failed: b.failed,
      failureRate: b.total > 0 ? (b.failed / b.total) * 100 : 0,
      lastRun: b.lastRun,
    }))
    .sort((a, b) => b.failureRate - a.failureRate || b.failed - a.failed)

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/super-admin" className="p-2 rounded-lg hover:bg-sage-50 text-sage-500 hover:text-sage-800">
          <ArrowLeft className="w-4 h-4" />
        </Link>
        <div>
          <h1 className="text-2xl font-serif text-sage-900 flex items-center gap-2">
            <Activity className="w-6 h-6 text-teal-600" />
            Observability
          </h1>
          <p className="text-sm text-sage-500 mt-0.5">
            Cron telemetry + metered counters. Last 7 days for crons, last 24 hours for counters.
          </p>
        </div>
      </div>

      {/* Cron summary by name */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-sage-800 flex items-center gap-2">
          <Clock className="w-4 h-4 text-teal-600" />
          Cron failure rate (7-day)
        </h2>
        {cronSummary.length === 0 ? (
          <p className="text-sm text-sage-500">No cron runs recorded in the last 7 days.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-sage-500 border-b border-border">
                  <th className="py-2">Cron</th>
                  <th className="py-2 text-right">Runs</th>
                  <th className="py-2 text-right">Failed</th>
                  <th className="py-2 text-right">Rate</th>
                  <th className="py-2 text-right">Last run</th>
                </tr>
              </thead>
              <tbody>
                {cronSummary.map((c) => {
                  const isHot = c.failureRate >= 25 && c.total >= 4
                  return (
                    <tr key={c.name} className="border-b border-border last:border-0">
                      <td className="py-2.5 font-mono text-xs text-sage-800">{c.name}</td>
                      <td className="py-2.5 text-right">{c.total}</td>
                      <td className={`py-2.5 text-right ${c.failed > 0 ? 'text-rose-600 font-medium' : 'text-sage-500'}`}>
                        {c.failed}
                      </td>
                      <td className={`py-2.5 text-right ${isHot ? 'text-rose-600 font-medium' : 'text-sage-700'}`}>
                        {c.failureRate.toFixed(0)}%
                      </td>
                      <td className="py-2.5 text-right text-xs text-sage-500">
                        {c.lastRun ? new Date(c.lastRun).toLocaleString() : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent runs */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-sage-800 flex items-center gap-2">
          <Activity className="w-4 h-4 text-teal-600" />
          Recent cron runs (last 200)
        </h2>
        {runs.length === 0 ? (
          <p className="text-sm text-sage-500">No runs yet.</p>
        ) : (
          <div className="space-y-1 max-h-[600px] overflow-y-auto">
            {runs.map((r) => {
              const sty = statusStyle(r.status)
              const Icon = sty.Icon
              return (
                <div key={r.id} className={`flex items-center gap-3 px-3 py-2 rounded-lg ${sty.bg}`}>
                  <Icon className={`w-4 h-4 ${sty.color}`} />
                  <span className="font-mono text-xs text-sage-800 flex-1 truncate">{r.cron_name}</span>
                  <span className="text-xs text-sage-500 w-20 text-right">{fmtDuration(r.duration_ms)}</span>
                  <span className="text-xs text-sage-500 w-16 text-right">{r.rows_processed ?? '—'} rows</span>
                  <span className="text-xs text-sage-500 w-44 text-right">{new Date(r.started_at).toLocaleString()}</span>
                  {r.error_message && (
                    <span className="text-xs text-rose-600 truncate max-w-xs" title={r.error_message}>
                      {r.error_message.slice(0, 60)}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Metered counters */}
      <section className="bg-surface border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-base font-semibold text-sage-800 flex items-center gap-2">
          <Gauge className="w-4 h-4 text-teal-600" />
          Metered counters (24-hour rollup)
        </h2>
        {meters.length === 0 ? (
          <p className="text-sm text-sage-500">No counter events in the last 24 hours.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-sage-500 border-b border-border">
                  <th className="py-2">Counter</th>
                  <th className="py-2 text-right">Events</th>
                  <th className="py-2 text-right">Sum</th>
                  <th className="py-2 text-right">Recent value</th>
                </tr>
              </thead>
              <tbody>
                {meters.map((m) => (
                  <tr key={m.counter_name} className="border-b border-border last:border-0">
                    <td className="py-2.5 font-mono text-xs text-sage-800">{m.counter_name}</td>
                    <td className="py-2.5 text-right">{m.count}</td>
                    <td className="py-2.5 text-right">{m.sum_value.toLocaleString()}</td>
                    <td className="py-2.5 text-right text-sage-500">{m.recent_value.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
