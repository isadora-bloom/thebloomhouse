'use client'

/**
 * /intel/sources/track — curated source-tracking page.
 *
 * Lists every entry in SOURCE_REGISTRY grouped by category. For each
 * source the coordinator can:
 *   - Click "Track this" to insert a tracked_sources row.
 *   - Click "Untrack" to soft-delete (graveyard=true).
 *   - Expand the import guide to see step-by-step instructions for
 *     pulling the data from the source platform and dropping it into
 *     the brain dump.
 *   - See badges for last-upload-N-days-ago and "needs an upload"
 *     when a tracked source has crossed its expected cadence.
 *
 * Two fetches on mount: /api/intel/sources/track (registry + tracked
 * rows) and /api/intel/sources/freshness (FreshnessReport[]). The two
 * are joined by source_key in the renderer.
 */

import { useEffect, useMemo, useState, useCallback } from 'react'
import Link from 'next/link'
import {
  Sparkles,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Plus,
  X,
} from 'lucide-react'
import {
  SOURCE_REGISTRY,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
  type SourceCategory,
  type SourceRegistryEntry,
} from '@/config/source-registry'
import type { FreshnessReport } from '@/lib/services/intel/source-freshness'

interface TrackedRow {
  id: string
  venue_id: string
  source_key: string
  expected_cadence_days: number
  last_reminded_at: string | null
  last_dismissed_at: string | null
  graveyard: boolean
  created_at: string
  updated_at: string
}

interface TrackApiResponse {
  tracked: TrackedRow[]
  registry: SourceRegistryEntry[]
}

interface FreshnessApiResponse {
  reports: FreshnessReport[]
}

export default function SourcesTrackPage() {
  const [tracked, setTracked] = useState<TrackedRow[]>([])
  const [reports, setReports] = useState<FreshnessReport[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pending, setPending] = useState<Set<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [trackRes, freshRes] = await Promise.all([
        fetch('/api/intel/sources/track'),
        fetch('/api/intel/sources/freshness'),
      ])
      if (!trackRes.ok) throw new Error(`Track HTTP ${trackRes.status}`)
      if (!freshRes.ok) throw new Error(`Freshness HTTP ${freshRes.status}`)
      const trackJson = (await trackRes.json()) as TrackApiResponse
      const freshJson = (await freshRes.json()) as FreshnessApiResponse
      setTracked(trackJson.tracked ?? [])
      setReports(freshJson.reports ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const trackedActiveByKey = useMemo(() => {
    const m = new Map<string, TrackedRow>()
    for (const r of tracked) {
      if (!r.graveyard) m.set(r.source_key, r)
    }
    return m
  }, [tracked])

  const reportByKey = useMemo(() => {
    const m = new Map<string, FreshnessReport>()
    for (const r of reports) m.set(r.source_key, r)
    return m
  }, [reports])

  const dueCount = useMemo(
    () => reports.filter((r) => r.reminder_due).length,
    [reports],
  )

  async function handleTrack(entry: SourceRegistryEntry) {
    setPending((p) => new Set(p).add(entry.key))
    try {
      const res = await fetch('/api/intel/sources/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source_key: entry.key,
          expected_cadence_days: entry.defaultCadenceDays,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to track')
    } finally {
      setPending((p) => {
        const next = new Set(p)
        next.delete(entry.key)
        return next
      })
    }
  }

  async function handleUntrack(entry: SourceRegistryEntry) {
    setPending((p) => new Set(p).add(entry.key))
    try {
      const res = await fetch(
        `/api/intel/sources/track?source_key=${encodeURIComponent(entry.key)}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to untrack')
    } finally {
      setPending((p) => {
        const next = new Set(p)
        next.delete(entry.key)
        return next
      })
    }
  }

  async function handleDismiss(entry: SourceRegistryEntry) {
    setPending((p) => new Set(p).add(entry.key))
    try {
      const res = await fetch('/api/intel/sources/dismiss', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_key: entry.key }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to dismiss')
    } finally {
      setPending((p) => {
        const next = new Set(p)
        next.delete(entry.key)
        return next
      })
    }
  }

  function toggleExpanded(key: string) {
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const grouped = useMemo(() => {
    const out: Record<SourceCategory, SourceRegistryEntry[]> = {
      listing: [],
      ads: [],
      organic: [],
      referral: [],
      email_marketing: [],
      other: [],
    }
    for (const e of SOURCE_REGISTRY) {
      out[e.category].push(e)
    }
    return out
  }, [])

  return (
    <div className="space-y-8">
      {/* ---- Header ---- */}
      <div>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="font-heading text-3xl font-bold text-sage-900 mb-1">
              Sources to track
            </h1>
            <p className="text-sage-600 max-w-3xl">
              Pick the platforms where your venue spends money or earns referrals.
              Sage will remind you to upload fresh data every month so the source
              scorecard stays honest. Each source has a short import guide so the
              coordinator knows where to find the numbers.
            </p>
          </div>
          <Link
            href="/intel/sources"
            className="text-sm text-sage-600 hover:text-sage-900 underline-offset-2 hover:underline whitespace-nowrap"
          >
            Back to scorecard
          </Link>
        </div>
      </div>

      {/* ---- Status banner ---- */}
      {dueCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-amber-900">
                {dueCount} source{dueCount === 1 ? '' : 's'} need an upload
              </p>
              <p className="text-xs text-amber-700 mt-0.5">
                Drop the latest data into the brain dump or click Dismiss to push
                the next reminder out two weeks.
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-800">
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="bg-surface border border-border rounded-xl p-6 animate-pulse">
              <div className="h-5 w-40 bg-sage-100 rounded mb-3" />
              <div className="h-3 w-72 bg-sage-50 rounded" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-10">
          {CATEGORY_ORDER.map((cat) => {
            const entries = grouped[cat]
            if (entries.length === 0) return null
            return (
              <section key={cat} className="space-y-3">
                <h2 className="font-heading text-xl font-semibold text-sage-900">
                  {CATEGORY_LABELS[cat]}
                </h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {entries.map((entry) => {
                    const trackedRow = trackedActiveByKey.get(entry.key)
                    const report = reportByKey.get(entry.key)
                    const isTracked = !!trackedRow
                    const isExpanded = expanded.has(entry.key)
                    const isPending = pending.has(entry.key)
                    return (
                      <SourceCard
                        key={entry.key}
                        entry={entry}
                        tracked={trackedRow ?? null}
                        report={report ?? null}
                        isExpanded={isExpanded}
                        isPending={isPending}
                        onToggle={() => toggleExpanded(entry.key)}
                        onTrack={() => handleTrack(entry)}
                        onUntrack={() => handleUntrack(entry)}
                        onDismiss={() => handleDismiss(entry)}
                        showDismiss={isTracked && (report?.reminder_due ?? false)}
                      />
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>
      )}

      <div className="text-xs text-sage-500 pt-6 border-t border-border">
        Want a source that is not in the registry? Drop it into the brain dump
        with the spend or count and Sage will start tracking it. The curated list
        only shows our recommended starting set.
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SourceCard
// ---------------------------------------------------------------------------

function SourceCard({
  entry,
  tracked,
  report,
  isExpanded,
  isPending,
  onToggle,
  onTrack,
  onUntrack,
  onDismiss,
  showDismiss,
}: {
  entry: SourceRegistryEntry
  tracked: TrackedRow | null
  report: FreshnessReport | null
  isExpanded: boolean
  isPending: boolean
  onToggle: () => void
  onTrack: () => void
  onUntrack: () => void
  onDismiss: () => void
  showDismiss: boolean
}) {
  const isTracked = !!tracked
  const reminderDue = report?.reminder_due ?? false
  const lastUploadAgo =
    report?.last_upload_at != null
      ? Math.max(0, Math.floor((Date.now() - new Date(report.last_upload_at).getTime()) / 86_400_000))
      : null

  return (
    <div
      className={`bg-surface border rounded-xl shadow-sm transition-colors ${
        reminderDue ? 'border-amber-300' : 'border-border'
      }`}
    >
      <div className="px-5 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-heading text-base font-semibold text-sage-900">
                {entry.label}
              </h3>
              {entry.tag === 'recommended' && (
                <span className="text-[10px] font-semibold tracking-wide uppercase bg-sage-100 text-sage-700 rounded px-1.5 py-0.5">
                  Recommended
                </span>
              )}
              {entry.tag === 'beta' && (
                <span className="text-[10px] font-semibold tracking-wide uppercase bg-blue-100 text-blue-700 rounded px-1.5 py-0.5">
                  Beta
                </span>
              )}
              {entry.tag === 'deprecated' && (
                <span className="text-[10px] font-semibold tracking-wide uppercase bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
                  Deprecated
                </span>
              )}
              {isTracked && !reminderDue && lastUploadAgo !== null && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium bg-emerald-50 text-emerald-700 rounded px-1.5 py-0.5"
                  title="Last upload was within the expected cadence"
                >
                  <CheckCircle2 className="w-3 h-3" />
                  Last upload {lastUploadAgo}d ago
                </span>
              )}
              {isTracked && reminderDue && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-amber-100 text-amber-800 rounded px-1.5 py-0.5">
                  <Clock className="w-3 h-3" />
                  Needs an upload
                </span>
              )}
              {isTracked && !reminderDue && lastUploadAgo === null && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium bg-sage-50 text-sage-600 rounded px-1.5 py-0.5">
                  <Sparkles className="w-3 h-3" />
                  Awaiting first upload
                </span>
              )}
            </div>
            <p className="text-xs text-sage-600 mt-1.5">{entry.description}</p>
            {isTracked && (
              <p className="text-[11px] text-sage-500 mt-1">
                Cadence: every {tracked.expected_cadence_days} days
                {report?.current_gap_days != null && (
                  <>
                    {' '}
                    · current gap: {report.current_gap_days}d
                  </>
                )}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1.5 shrink-0">
            {isTracked ? (
              <button
                onClick={onUntrack}
                disabled={isPending}
                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg border border-border text-sage-700 hover:bg-sage-50 transition-colors disabled:opacity-50"
              >
                <X className="w-3 h-3" />
                Untrack
              </button>
            ) : (
              <button
                onClick={onTrack}
                disabled={isPending}
                className="inline-flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-lg bg-sage-700 text-white hover:bg-sage-800 transition-colors disabled:opacity-50"
              >
                <Plus className="w-3 h-3" />
                Track this
              </button>
            )}
            {showDismiss && (
              <button
                onClick={onDismiss}
                disabled={isPending}
                className="text-[11px] text-sage-500 hover:text-sage-800 underline-offset-2 hover:underline disabled:opacity-50"
                title="Suppress reminders for 14 days"
              >
                Dismiss for 2 weeks
              </button>
            )}
          </div>
        </div>

        <button
          onClick={onToggle}
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-sage-600 hover:text-sage-900"
          aria-expanded={isExpanded}
        >
          {isExpanded ? (
            <ChevronUp className="w-3.5 h-3.5" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5" />
          )}
          {isExpanded ? 'Hide import guide' : 'Show import guide'}
        </button>

        {isExpanded && (
          <div className="mt-3 bg-sage-50/60 border border-sage-100 rounded-lg p-3 space-y-2">
            <p className="text-xs font-semibold text-sage-800">
              {entry.importGuide.title}
            </p>
            <ol className="list-decimal list-inside space-y-1 text-xs text-sage-700 marker:text-sage-400">
              {entry.importGuide.steps.map((step, i) => (
                <li key={i} className="leading-snug">
                  {step}
                </li>
              ))}
            </ol>
            {entry.importGuide.helpUrl && (
              <a
                href={entry.importGuide.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-sage-600 hover:text-sage-900 underline-offset-2 hover:underline"
              >
                Platform help docs <ExternalLink className="w-3 h-3" />
              </a>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
