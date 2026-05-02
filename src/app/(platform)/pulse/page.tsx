'use client'

/**
 * /pulse — unified pulse surface (ARCH-20.2.2).
 *
 * Coordinator's single inbox for things that need attention. Aggregates
 * admin_notifications + anomaly_alerts + intelligence_insights via
 * /api/pulse. Pre-this-file these were spread across /agent/notifications,
 * /intel/anomalies, /intel/market-pulse, and the dashboard cards.
 *
 * MVP ships as a flat priority-sorted feed. Snooze + escalate-to-
 * brain-dump are follow-up features that build on the same source.
 */

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Loader2, AlertTriangle, Bell, Lightbulb, RefreshCw, ExternalLink,
  Clock, X,
} from 'lucide-react'

type PulseSource = 'notification' | 'anomaly' | 'insight'
type PulsePriority = 'critical' | 'high' | 'medium' | 'low'

interface PulseItem {
  id: string
  source: PulseSource
  priority: PulsePriority
  title: string
  body: string | null
  href: string | null
  createdAt: string
  metadata: Record<string, unknown>
}

const PRIORITY_STYLES: Record<PulsePriority, { bg: string; text: string; label: string }> = {
  critical: { bg: 'bg-red-50',     text: 'text-red-700',     label: 'Critical' },
  high:     { bg: 'bg-amber-50',   text: 'text-amber-700',   label: 'High'     },
  medium:   { bg: 'bg-sage-50',    text: 'text-sage-700',    label: 'Medium'   },
  low:      { bg: 'bg-sage-50/50', text: 'text-sage-500',    label: 'Low'      },
}

const SOURCE_ICON: Record<PulseSource, typeof Bell> = {
  notification: Bell,
  anomaly: AlertTriangle,
  insight: Lightbulb,
}

function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.floor(ms / 60_000)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const days = Math.floor(hr / 24)
  return `${days}d`
}

export default function PulsePage() {
  const router = useRouter()
  const [items, setItems] = useState<PulseItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<PulseSource | 'all'>('all')
  const [busyKey, setBusyKey] = useState<string | null>(null)

  async function snooze(itemKey: string, days: number) {
    setBusyKey(itemKey)
    try {
      const snoozedUntilIso = new Date(Date.now() + days * 86_400_000).toISOString()
      const res = await fetch('/api/pulse/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemKey, action: 'snoozed', snoozedUntilIso }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      // Optimistic: remove locally rather than refetch.
      setItems((prev) => prev.filter((it) => it.id !== itemKey))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Snooze failed')
    } finally {
      setBusyKey(null)
    }
  }

  async function dismiss(itemKey: string) {
    setBusyKey(itemKey)
    try {
      const res = await fetch('/api/pulse/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemKey, action: 'dismissed' }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      setItems((prev) => prev.filter((it) => it.id !== itemKey))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dismiss failed')
    } finally {
      setBusyKey(null)
    }
  }

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/pulse')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { items: PulseItem[] }
      setItems(json.items)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pulse')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  const visible = filter === 'all' ? items : items.filter((it) => it.source === filter)

  const counts = {
    all: items.length,
    notification: items.filter((it) => it.source === 'notification').length,
    anomaly: items.filter((it) => it.source === 'anomaly').length,
    insight: items.filter((it) => it.source === 'insight').length,
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-heading text-3xl font-semibold text-sage-900">Pulse</h1>
          <p className="text-sm text-sage-600 mt-1">
            Unified feed of notifications, anomalies, and high-priority insights.
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="inline-flex items-center gap-2 text-sm text-sage-600 hover:text-sage-900 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Source filter pills. */}
      <div className="flex items-center gap-1 bg-sage-50 rounded-lg p-1 inline-flex">
        {(['all', 'notification', 'anomaly', 'insight'] as const).map((s) => {
          const label = s === 'all' ? 'All' : s === 'notification' ? 'Notifications' : s === 'anomaly' ? 'Anomalies' : 'Insights'
          return (
            <button
              key={s}
              onClick={() => setFilter(s)}
              className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                filter === s ? 'bg-surface text-sage-900 shadow-sm' : 'text-sage-600 hover:text-sage-800'
              }`}
            >
              {label} <span className="text-xs text-sage-500">{counts[s]}</span>
            </button>
          )
        })}
      </div>

      {loading && items.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-sage-500 py-12 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading…
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          {error}
        </div>
      )}

      {!loading && visible.length === 0 && (
        <div className="rounded-lg border border-sage-200 bg-warm-white p-12 text-center text-sage-500">
          <Bell className="w-10 h-10 mx-auto mb-3 text-sage-300" />
          <p className="text-sm">All clear. Nothing demands your attention right now.</p>
        </div>
      )}

      <ul className="space-y-2">
        {visible.map((item) => {
          const Icon = SOURCE_ICON[item.source]
          const pri = PRIORITY_STYLES[item.priority]
          const acting = busyKey === item.id
          return (
            <li
              key={item.id}
              className={`rounded-lg border border-sage-200 bg-warm-white p-4 hover:bg-sage-50/50 transition-colors`}
            >
              <div className="flex items-start gap-3">
                <Icon className="w-4 h-4 text-sage-500 mt-0.5 shrink-0" />
                <div
                  className={`flex-1 min-w-0 ${item.href ? 'cursor-pointer' : ''}`}
                  onClick={() => { if (item.href) router.push(item.href) }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${pri.bg} ${pri.text}`}>
                      {pri.label}
                    </span>
                    <span className="text-xs text-sage-500 capitalize">{item.source}</span>
                    <span className="text-xs text-sage-400">· {formatAge(item.createdAt)} ago</span>
                  </div>
                  <h3 className="text-sm font-medium text-sage-900 mt-1 truncate">{item.title}</h3>
                  {item.body && (
                    <p className="text-sm text-sage-600 mt-1 line-clamp-2">{item.body}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={(e) => { e.stopPropagation(); snooze(item.id, 1) }}
                    disabled={acting}
                    title="Snooze 1 day"
                    className="p-1 rounded hover:bg-sage-100 text-sage-500 hover:text-sage-700 disabled:opacity-50"
                  >
                    {acting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Clock className="w-3 h-3" />}
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); snooze(item.id, 7) }}
                    disabled={acting}
                    title="Snooze 1 week"
                    className="p-1 rounded hover:bg-sage-100 text-xs text-sage-500 hover:text-sage-700 disabled:opacity-50"
                  >
                    7d
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); dismiss(item.id) }}
                    disabled={acting}
                    title="Dismiss forever"
                    className="p-1 rounded hover:bg-red-50 text-sage-400 hover:text-red-600 disabled:opacity-50"
                  >
                    <X className="w-3 h-3" />
                  </button>
                  {item.href && <ExternalLink className="w-3 h-3 text-sage-400 ml-1" />}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
