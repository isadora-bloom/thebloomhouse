'use client'

/**
 * Recent-merges digest tab.
 *
 * Anchor: §7 OPERATOR-BLOCK. Operator wants a single-screen view of
 * the identity moves Bloom (or a coordinator) committed in the last
 * 24-72 hours, with an undo button for anything that looks wrong.
 * Pre-this, recognising a bad merge required scrolling the review
 * queue row-by-row and recognising the couple pair.
 *
 * Data
 * ----
 *   GET  /api/admin/identity/recent-merges?window_hours=72
 *   POST /api/admin/identity/undo-merge
 *
 * Honesty
 * -------
 * Empty windows render as "No recent identity moves in this window" —
 * never as zeros that look like a confident answer (§C.6).
 */

import { useCallback, useEffect, useState } from 'react'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  Check,
  Clock,
  GitMerge,
  Loader2,
  RefreshCw,
  Undo2,
  User,
} from 'lucide-react'
import type {
  RecentMergeRow,
  RecentMergesPage,
} from '@/lib/services/identity/recent-merges'

interface ApiResponse {
  ok: boolean
  page?: RecentMergesPage
  error?: string
}

interface UndoApiResponse {
  ok: boolean
  applied?: string
  recreated_person_id?: string | null
  reversal_event_type?: string
  candidate_match_reverted?: boolean
  fragment_unpromoted?: boolean
  hint?: string | null
  error?: string
}

const WINDOW_CHOICES = [
  { label: 'Last 24h', hours: 24 },
  { label: 'Last 72h', hours: 72 },
  { label: 'Last 7d', hours: 168 },
] as const

function tierClass(tier: 'high' | 'medium' | 'low' | null): string {
  if (tier === 'high') return 'bg-emerald-100 text-emerald-800 border-emerald-200'
  if (tier === 'medium') return 'bg-amber-100 text-amber-800 border-amber-200'
  if (tier === 'low') return 'bg-stone-100 text-stone-700 border-stone-200'
  return 'bg-stone-100 text-stone-500 border-stone-200'
}

function fmtTimeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso)
  const mins = Math.round(ms / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  return `${days}d ago`
}

export default function RecentMergesTab() {
  const [data, setData] = useState<RecentMergesPage | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [windowHours, setWindowHours] = useState<number>(72)
  const [undoState, setUndoState] = useState<
    Record<string, { state: 'idle' | 'busy' | 'done' | 'error'; message?: string }>
  >({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/admin/identity/recent-merges?window_hours=${windowHours}`,
        { cache: 'no-store' },
      )
      const body = (await res.json()) as ApiResponse
      if (!res.ok || !body.ok || !body.page) {
        setError(body.error ?? `HTTP ${res.status}`)
      } else {
        setData(body.page)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [windowHours])

  useEffect(() => {
    void load()
  }, [load])

  // Light auto-refresh — every 60s pull a fresh page so a new merge
  // committed by the linker shows up without the operator hitting refresh.
  useEffect(() => {
    const handle = window.setInterval(() => {
      void load()
    }, 60_000)
    return () => window.clearInterval(handle)
  }, [load])

  const undo = async (row: RecentMergeRow) => {
    const note = window.prompt(
      'Optional: why are you undoing this merge? (helps the calibration loop)',
      '',
    )
    if (note === null) return // user cancelled
    setUndoState((s) => ({ ...s, [row.id]: { state: 'busy' } }))
    try {
      const res = await fetch('/api/admin/identity/undo-merge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          source: row.source,
          audit_id: row.id,
          reason: note.trim() || undefined,
        }),
      })
      const body = (await res.json()) as UndoApiResponse
      if (!res.ok || !body.ok) {
        setUndoState((s) => ({
          ...s,
          [row.id]: {
            state: 'error',
            message: body.error ?? `HTTP ${res.status}`,
          },
        }))
        return
      }
      // Surface useful side-effect hints inline.
      const parts: string[] = []
      if (body.applied === 'person_recreated') {
        parts.push('person recreated')
      } else if (body.applied === 'reversal_logged') {
        parts.push(`logged ${body.reversal_event_type ?? 'reversal'}`)
        if (body.candidate_match_reverted) parts.push('candidate re-opened')
        if (body.fragment_unpromoted) parts.push('fragment un-promoted')
      }
      setUndoState((s) => ({
        ...s,
        [row.id]: {
          state: 'done',
          message: parts.join(' · ') + (body.hint ? ` — ${body.hint}` : ''),
        },
      }))
    } catch (err) {
      setUndoState((s) => ({
        ...s,
        [row.id]: {
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
        },
      }))
    }
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 rounded-md border border-stone-200 bg-white p-1">
          {WINDOW_CHOICES.map((c) => (
            <button
              key={c.hours}
              type="button"
              onClick={() => setWindowHours(c.hours)}
              className={`rounded px-2.5 py-1 text-xs ${
                windowHours === c.hours
                  ? 'bg-stone-900 text-white'
                  : 'text-stone-700 hover:bg-stone-50'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RefreshCw className="h-3 w-3" />
          )}
          Refresh
        </button>
        <span className="ml-auto text-xs text-stone-500">
          Auto-refreshes every 60s. Showing identity moves Bloom (or a
          coordinator) committed in the last {windowHours}h.
        </span>
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <AlertCircle className="mt-0.5 h-4 w-4" />
          <div>{error}</div>
        </div>
      )}

      {loading && !data && (
        <div className="rounded-lg border border-stone-200 bg-white p-8 text-center text-sm text-stone-500">
          Loading recent merges...
        </div>
      )}

      {data && data.rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-stone-300 bg-stone-50/60 p-8 text-center">
          <Clock className="mx-auto mb-2 h-5 w-5 text-stone-400" />
          <p className="text-sm text-stone-600">
            No identity moves in the last {windowHours} hours.
          </p>
          <p className="mt-1 text-xs text-stone-500">
            Bloom is quiet, or the matcher is staying inside its tier-1
            auto-promotion threshold. Either is fine.
          </p>
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div className="space-y-3">
          {data.rows.map((row) => {
            const status = undoState[row.id]
            const busy = status?.state === 'busy'
            const done = status?.state === 'done' || row.undone
            const failed = status?.state === 'error'
            const primaryLabel =
              row.primary.label ??
              (row.primary.id ? `(${row.primary.id.slice(0, 8)}...)` : '(unknown)')
            const secondaryLabel =
              row.secondary.label ??
              (row.secondary.id ? `(${row.secondary.id.slice(0, 8)}...)` : '(unknown)')
            return (
              <div
                key={`${row.source}:${row.id}`}
                className="overflow-hidden rounded-lg border border-stone-200 bg-white"
              >
                <div className="flex items-center justify-between border-b border-stone-100 bg-stone-50 px-4 py-2 text-xs">
                  <div className="flex items-center gap-2">
                    <GitMerge className="h-3.5 w-3.5 text-stone-500" />
                    <span className="font-medium text-stone-700">
                      {row.kindLabel}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${tierClass(
                        row.confidenceTier,
                      )}`}
                    >
                      {row.confidenceTier ?? 'unknown'}
                    </span>
                    <span className="inline-flex items-center gap-1 text-stone-500">
                      {row.actor === 'auto' ? (
                        <>
                          <Bot className="h-3 w-3" /> auto
                        </>
                      ) : (
                        <>
                          <User className="h-3 w-3" /> operator
                        </>
                      )}
                    </span>
                  </div>
                  <span className="text-stone-500" title={row.occurredAt}>
                    {fmtTimeAgo(row.occurredAt)}
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-[1fr_auto_1fr]">
                  <CoupleCard
                    side="Into"
                    label={primaryLabel}
                    id={row.primary.id}
                    source={row.source}
                  />
                  <div className="hidden self-center text-stone-300 sm:block">
                    <ArrowRight className="h-5 w-5" />
                  </div>
                  <CoupleCard
                    side="From"
                    label={secondaryLabel}
                    id={row.secondary.id}
                    source={row.source}
                  />
                </div>
                {(row.ruleTriggered || row.reason) && (
                  <div className="border-t border-stone-100 bg-stone-50/60 px-4 py-2 text-xs text-stone-600">
                    {row.ruleTriggered && (
                      <div>
                        <span className="text-stone-400">Rule:</span>{' '}
                        <code className="text-stone-700">{row.ruleTriggered}</code>
                      </div>
                    )}
                    {row.reason && (
                      <div className="mt-1 italic">"{row.reason}"</div>
                    )}
                  </div>
                )}
                <div className="flex items-center justify-between border-t border-stone-100 px-4 py-2">
                  <div className="text-xs text-stone-500">
                    {status?.message && (
                      <span
                        className={failed ? 'text-red-700' : done ? 'text-emerald-700' : 'text-stone-700'}
                      >
                        {status.message}
                      </span>
                    )}
                    {!status?.message && row.undone && (
                      <span className="text-stone-500">Already undone.</span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => void undo(row)}
                    disabled={busy || done}
                    className={`inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium ${
                      done
                        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                        : busy
                          ? 'border-stone-200 bg-stone-50 text-stone-500'
                          : 'border-stone-300 bg-white text-stone-800 hover:bg-stone-50'
                    } disabled:cursor-not-allowed`}
                  >
                    {busy ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : done ? (
                      <Check className="h-3 w-3" />
                    ) : (
                      <Undo2 className="h-3 w-3" />
                    )}
                    {busy ? 'Undoing...' : done ? 'Undone' : 'Undo'}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CoupleCard({
  side,
  label,
  id,
  source,
}: {
  side: 'Into' | 'From'
  label: string
  id: string | null
  source: 'couple_event' | 'person_merge'
}) {
  // Couple-side rows have a /intel/couples/[id] page; person-merge
  // rows don't have a dedicated person detail page in the platform
  // shell, so we just render the label.
  const href = source === 'couple_event' && id ? `/intel/couples/${id}` : null
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wide text-stone-500">
        {side}
      </div>
      {href ? (
        <a
          href={href}
          className="text-sm font-medium text-stone-900 underline-offset-2 hover:underline"
        >
          {label}
        </a>
      ) : (
        <div className="text-sm font-medium text-stone-900">{label}</div>
      )}
    </div>
  )
}
