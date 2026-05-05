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
 *
 * Phase 6 FIX 3: realtime subscription on admin_notifications so new
 * notifications (auto-send cap, Gmail token errors, etc.) appear without
 * a manual refresh.
 */

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import {
  Loader2, AlertTriangle, Bell, Lightbulb, RefreshCw, ExternalLink,
  Clock, X, PauseCircle, PlayCircle,
} from 'lucide-react'
import { InlineInsightBanner } from '@/components/intel/inline-insight-banner'
import { createClient } from '@/lib/supabase/client'

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

interface PulsePausedBanner {
  paused: boolean
  pausedAt: string | null
  pausedReason: string | null
  ceilingCents: number
  spendCents: number
  utilisation: number
  resumeAt: string
  skipCounts: Record<string, number>
  totalSkipped: number
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

function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function formatWorkType(workType: string): string {
  // 'weekly_digest' -> 'weekly digest', good enough for a notification breakdown.
  return workType.replace(/_/g, ' ')
}

export default function PulsePage() {
  const router = useRouter()
  const [items, setItems] = useState<PulseItem[]>([])
  const [pausedBanner, setPausedBanner] = useState<PulsePausedBanner | null>(null)
  const [resumingPause, setResumingPause] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<PulseSource | 'all'>('all')
  const [busyKey, setBusyKey] = useState<string | null>(null)
  // venueId is captured from the first API response and used for the
  // realtime subscription so new notifications appear without a manual refresh.
  const [venueId, setVenueId] = useState<string | null>(null)

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
      const json = (await res.json()) as { venueId?: string; items: PulseItem[]; pausedBanner: PulsePausedBanner | null }
      setItems(json.items)
      setPausedBanner(json.pausedBanner ?? null)
      // Capture venueId on first load for the realtime subscription.
      if (json.venueId) setVenueId(json.venueId)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load pulse')
    } finally {
      setLoading(false)
    }
  }, [])

  // T5-eta.1: coordinator-initiated resume from the paused banner.
  // Confirms because resuming opens up auto-send + brain-call work
  // that the cost ceiling explicitly paused — coordinator should
  // know what they're agreeing to.
  async function resumePause() {
    if (resumingPause) return
    if (!confirm(
      'Resume autonomous behavior? This re-enables auto-send + proactive insights ' +
      'before the daily cost ceiling resets at UTC midnight. You can investigate ' +
      'spend at /agent/cost-ceiling first.'
    )) return
    setResumingPause(true)
    try {
      const res = await fetch('/api/agent/cost-ceiling/resume', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resume')
    } finally {
      setResumingPause(false)
    }
  }

  // T5-eta.2: replay the work skipped during the pause window. Hits
  // the /api/agent/cost-ceiling/replay endpoint which marks rows as
  // replayed BEFORE firing the work (so retry doesn't double-fire).
  async function replaySkipped() {
    if (resumingPause) return
    setResumingPause(true)
    try {
      const res = await fetch('/api/agent/cost-ceiling/replay', { method: 'POST' })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to replay skipped work')
    } finally {
      setResumingPause(false)
    }
  }

  useEffect(() => { refresh() }, [refresh])

  // Phase 6 FIX 3: Realtime subscription on admin_notifications.
  // When a new notification arrives for this venue (e.g. auto-send cap
  // reached, Gmail token expired), refetch the full pulse so the
  // coordinator sees it immediately without a manual refresh.
  useEffect(() => {
    if (!venueId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`pulse-${venueId}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'admin_notifications',
        filter: `venue_id=eq.${venueId}`,
      }, () => {
        refresh()
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [venueId, refresh])

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

      {/* Stream HHH Bug 10: high-severity risk insights surface here
          (and on /intel/dashboard) — not on every coordinator page. */}
      <InlineInsightBanner surface="pulse" />

      {/* T5-eta.1 — paused banner. Sticky-pinned, NOT a notification:
          coordinator cannot snooze or dismiss this. Tells them the
          venue's autonomous behavior is paused, since when, what was
          skipped during the window, and offers Resume + Replay. */}
      {pausedBanner && pausedBanner.paused && (
        <div className="rounded-lg border-2 border-amber-300 bg-amber-50 p-4 space-y-3">
          <div className="flex items-start gap-3">
            <PauseCircle className="w-5 h-5 text-amber-700 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <h2 className="font-medium text-amber-900">
                Autonomous behavior paused — daily cost ceiling reached
              </h2>
              <p className="text-sm text-amber-800 mt-1">
                {pausedBanner.pausedAt && (
                  <>Paused since {new Date(pausedBanner.pausedAt).toLocaleString()}. </>
                )}
                Spend today: {formatDollars(pausedBanner.spendCents)} of{' '}
                {formatDollars(pausedBanner.ceilingCents)} ceiling
                ({Math.round(pausedBanner.utilisation * 100)}%).
                {' '}Auto-resumes at {new Date(pausedBanner.resumeAt).toLocaleString()}.
              </p>
              {pausedBanner.totalSkipped > 0 && (
                <div className="mt-2 text-sm text-amber-800">
                  <strong>Skipped during pause:</strong>{' '}
                  {Object.entries(pausedBanner.skipCounts)
                    .map(([wt, n]) => `${n} ${formatWorkType(wt)}${n > 1 ? 's' : ''}`)
                    .join(', ')}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={resumePause}
              disabled={resumingPause}
              className="inline-flex items-center gap-2 rounded-md bg-amber-700 hover:bg-amber-800 text-white px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {resumingPause ? <Loader2 className="w-3 h-3 animate-spin" /> : <PlayCircle className="w-3 h-3" />}
              Resume early
            </button>
            {pausedBanner.totalSkipped > 0 && (
              <button
                onClick={replaySkipped}
                disabled={resumingPause}
                className="inline-flex items-center gap-2 rounded-md border border-amber-700 text-amber-800 hover:bg-amber-100 px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              >
                {resumingPause ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Run skipped work now ({pausedBanner.totalSkipped})
              </button>
            )}
          </div>
        </div>
      )}

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
