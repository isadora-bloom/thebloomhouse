'use client'

/**
 * Wave 8 — /intel/external-signals dashboard.
 *
 * Anchor docs:
 *   - bloom-constitution.md (one source of truth, derive the rest)
 *   - feedback_deep_fix_vs_bandaid.md (layer fix not rule fix)
 *
 * What this page does
 * -------------------
 * Single-pane status of every external signal that feeds the correlation
 * engine + market-pulse + cohort intel. For each of the 8 signals
 * (google_trends, weather, holiday_calendar, government, cultural_moments,
 * market_intelligence, fred, census), shows:
 *   - status pill (ready / config_missing / data_stale / error / disabled)
 *   - last refresh timestamp (relative)
 *   - record count
 *   - missing-config-fields list with deep-link to /settings/venue-info
 *   - last_error (collapsible)
 *
 * Hero shows green/yellow/red counts + a "Run health check now" button.
 *
 * This is the "fix once, see everywhere" surface that closes the
 * whack-a-mole pattern.
 */

import { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, Activity, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { ExternalSignalStatusCard } from '@/components/intel/ExternalSignalStatusCard'

interface SignalHealthRow {
  signal_name: string
  status: 'ready' | 'config_missing' | 'data_stale' | 'error' | 'disabled'
  missing_config_fields: string[]
  last_refresh_at: string | null
  record_count: number
  last_error: string | null
  last_checked_at: string
  display_label: string
  display_description: string
}

interface StatusResponse {
  ok: true
  venueId: string
  counts: {
    total: number
    ready: number
    config_missing: number
    data_stale: number
    error: number
    disabled: number
  }
  signals: SignalHealthRow[]
  checkedAt: string
}

export const dynamic = 'force-dynamic'

export default function ExternalSignalsPage() {
  const [data, setData] = useState<StatusResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const resp = await fetch('/api/admin/external-signals/status')
      if (!resp.ok) {
        const j = (await resp.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? `HTTP ${resp.status}`)
      }
      const json = (await resp.json()) as StatusResponse
      setData(json)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const handleHeroRefresh = async () => {
    setRefreshing(true)
    await load()
  }

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-10 flex items-center gap-2 text-sage-500">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading external-signal health…
      </div>
    )
  }

  if (error) {
    return (
      <div className="max-w-6xl mx-auto px-6 py-10">
        <div className="rounded-xl bg-red-50 border border-red-200 p-6 text-red-800">
          <div className="font-medium mb-1">Couldn&apos;t load external-signal status</div>
          <div className="text-sm">{error}</div>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 inline-flex items-center gap-1.5 text-sm underline"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      </div>
    )
  }

  if (!data) return null

  const greenCount = data.counts.ready
  const yellowCount = data.counts.config_missing + data.counts.data_stale
  const redCount = data.counts.error
  const overallHealthy = greenCount === data.counts.total

  return (
    <div className="max-w-6xl mx-auto px-6 py-10">
      <header className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Activity className="w-5 h-5 text-sage-700" />
          <h1 className="font-heading text-2xl font-bold text-sage-900">
            External Signals
          </h1>
        </div>
        <p className="text-sm text-sage-600 leading-relaxed max-w-2xl">
          Every external signal that feeds the correlation engine, cohort intel,
          and market pulse. When a signal is &quot;config missing,&quot; the
          venue&apos;s address probably isn&apos;t fully derived yet — fix once
          on the venue-info page and every dependent surface lights up.
        </p>
      </header>

      <section className="mb-8 rounded-xl border border-sage-100 bg-white p-6">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-600" />
              <div>
                <div className="text-2xl font-bold text-sage-900">{greenCount}</div>
                <div className="text-xs text-sage-500">Ready</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-amber-600" />
              <div>
                <div className="text-2xl font-bold text-sage-900">{yellowCount}</div>
                <div className="text-xs text-sage-500">Needs config / stale</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-5 h-5 text-red-600" />
              <div>
                <div className="text-2xl font-bold text-sage-900">{redCount}</div>
                <div className="text-xs text-sage-500">Errors</div>
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleHeroRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sage-700 text-white text-sm font-medium hover:bg-sage-800 disabled:opacity-60"
          >
            {refreshing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
            Run health check
          </button>
        </div>
        {overallHealthy && (
          <div className="mt-4 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            All {data.counts.total} signals are ready. The intelligence loop has
            full external context.
          </div>
        )}
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {data.signals.map((s) => (
          <ExternalSignalStatusCard key={s.signal_name} signal={s} />
        ))}
      </section>

      <p className="mt-8 text-xs text-sage-500">
        Last checked: {new Date(data.checkedAt).toLocaleString()}
      </p>
    </div>
  )
}
