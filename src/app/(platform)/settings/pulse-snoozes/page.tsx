'use client'

/**
 * Settings → Pulse snoozes (T5-followup-W / seasoned MED 16).
 *
 * Coordinator-facing audit of every active snooze + dismissal on the
 * /pulse feed. Pre-this-page pulse_snoozes rows accumulated silently;
 * a coordinator who dismissed an item six weeks ago had no way to
 * un-dismiss it short of re-discovering it in the source feed. This
 * page lists everything that's currently filtered, with a one-click
 * un-snooze that hits DELETE /api/pulse/snooze.
 *
 * Server-side filtering: the GET handler already excludes expired
 * snoozes (snoozed_until < now()) and expired dismissals (created_at
 * older than the 90-day TTL — eng LOW 24). The nightly cron
 * `prune_expired_pulse_snoozes` then DELETEs those zombie rows so the
 * table stays bounded.
 */

import { useEffect, useState } from 'react'
import { BellOff, Trash2, Clock, EyeOff } from 'lucide-react'

interface SnoozeRow {
  id: string
  item_key: string
  action: 'snoozed' | 'dismissed'
  snoozed_until: string | null
  reason: string | null
  created_at: string
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function fmtRelative(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.parse(iso) - Date.now()
  const abs = Math.abs(ms)
  const days = Math.floor(abs / 86_400_000)
  const hours = Math.floor((abs % 86_400_000) / 3_600_000)
  if (ms > 0) {
    if (days > 0) return `in ${days}d ${hours}h`
    return `in ${hours}h`
  }
  if (days > 0) return `${days}d ago`
  return `${hours}h ago`
}

function sourceLabel(itemKey: string): string {
  if (itemKey.startsWith('notif:')) return 'Notification'
  if (itemKey.startsWith('anomaly:')) return 'Anomaly'
  if (itemKey.startsWith('insight:')) return 'Insight'
  return 'Pulse item'
}

export default function PulseSnoozesPage() {
  const [rows, setRows] = useState<SnoozeRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unsnoozingId, setUnsnoozingId] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/pulse/snooze')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = (await res.json()) as { snoozes?: SnoozeRow[] }
      setRows(json.snoozes ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  async function handleUnsnooze(itemKey: string) {
    setUnsnoozingId(itemKey)
    setError(null)
    try {
      const res = await fetch(`/api/pulse/snooze?itemKey=${encodeURIComponent(itemKey)}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Failed' }))
        throw new Error(err.error || 'Failed to un-snooze')
      }
      await load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to un-snooze')
    } finally {
      setUnsnoozingId(null)
    }
  }

  const snoozes = rows.filter((r) => r.action === 'snoozed')
  const dismisses = rows.filter((r) => r.action === 'dismissed')

  return (
    <div className="max-w-4xl space-y-8">
      <header className="flex items-center gap-3">
        <BellOff className="w-6 h-6 text-sage-600" />
        <div>
          <h1 className="text-2xl font-serif text-sage-900">Pulse snoozes</h1>
          <p className="text-sm text-sage-600 mt-1">
            Items you&apos;ve snoozed or dismissed from{' '}
            <a href="/pulse" className="text-sage-700 underline hover:text-sage-900">
              /pulse
            </a>
            . Snoozed items re-surface automatically when their timer expires.
            Dismissed items re-surface after 90 days unless you re-dismiss them.
            Click un-snooze on any row to put it back on the feed now.
          </p>
        </div>
      </header>

      {error && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-4 py-2">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-sage-500">Loading…</div>
      ) : (
        <>
          <SnoozeGroup
            title="Active snoozes"
            subtitle="Hidden until the snooze timer expires."
            icon={<Clock className="w-4 h-4" />}
            items={snoozes}
            onUnsnooze={handleUnsnooze}
            unsnoozingId={unsnoozingId}
            empty="Nothing snoozed."
            showSnoozedUntil
          />
          <SnoozeGroup
            title="Dismissed"
            subtitle="Hidden for 90 days from when you dismissed them."
            icon={<EyeOff className="w-4 h-4" />}
            items={dismisses}
            onUnsnooze={handleUnsnooze}
            unsnoozingId={unsnoozingId}
            empty="Nothing dismissed."
            showSnoozedUntil={false}
          />
        </>
      )}
    </div>
  )
}

function SnoozeGroup({
  title,
  subtitle,
  icon,
  items,
  onUnsnooze,
  unsnoozingId,
  empty,
  showSnoozedUntil,
}: {
  title: string
  subtitle: string
  icon: React.ReactNode
  items: SnoozeRow[]
  onUnsnooze: (itemKey: string) => void
  unsnoozingId: string | null
  empty: string
  showSnoozedUntil: boolean
}) {
  return (
    <section className="space-y-2">
      <div>
        <h2 className="text-sm font-medium text-sage-800 inline-flex items-center gap-2">
          {icon}
          {title}
          <span className="text-xs text-sage-500">({items.length})</span>
        </h2>
        <p className="text-xs text-sage-500">{subtitle}</p>
      </div>
      {items.length === 0 ? (
        <div className="text-sm text-sage-500 border border-dashed border-border rounded-lg px-4 py-6 text-center">
          {empty}
        </div>
      ) : (
        <div className="border border-border rounded-lg bg-warm-white divide-y divide-border">
          {items.map((row) => (
            <div key={row.id} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-sage-100 text-sage-700">
                    {sourceLabel(row.item_key)}
                  </span>
                  <code className="text-xs font-mono text-sage-700 truncate">{row.item_key}</code>
                </div>
                <div className="text-xs text-sage-500 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  <span>Created {fmtRelative(row.created_at)} ({fmtDateTime(row.created_at)})</span>
                  {showSnoozedUntil && row.snoozed_until && (
                    <span>
                      Re-surfaces {fmtRelative(row.snoozed_until)} ({fmtDateTime(row.snoozed_until)})
                    </span>
                  )}
                </div>
                {row.reason && (
                  <p className="text-xs text-sage-600 mt-1 italic">&quot;{row.reason}&quot;</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onUnsnooze(row.item_key)}
                disabled={unsnoozingId === row.item_key}
                className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-sage-200 text-sage-700 text-xs hover:bg-sage-50 disabled:opacity-50 transition-colors"
                title="Un-snooze and put back on /pulse"
              >
                <Trash2 className="w-3 h-3" />
                {unsnoozingId === row.item_key ? 'Working…' : 'Un-snooze'}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
