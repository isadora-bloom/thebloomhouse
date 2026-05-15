'use client'

/**
 * Identity-First Phase B — Tracer run history + on-demand trigger.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 + Appendix A.
 *
 * Shows the last 20 runs for the current venue (or all venues for
 * super_admin), with per-stage status pills, run totals, and a "Run
 * now" button that POSTs to /api/admin/tracer/run.
 *
 * What this page is NOT
 * --------------------
 * - The candidate-match review queue. That lives at
 *   /intel/identity-review (Phase E). This page is about the engine,
 *   not the proposals it produces.
 * - A general identity-resolution explorer. That's a deeper Phase D/E
 *   surface. This page is the operator-visible heartbeat of the
 *   Tracer.
 */

import { useEffect, useState } from 'react'
import { Play, RefreshCw, AlertTriangle, CheckCircle2, Circle, XCircle } from 'lucide-react'

interface RunSummary {
  run_id: string
  latest_event_at: string
  latest_stage: string
  latest_status: string
  stages_succeeded: string[]
  stages_failed: string[]
  totals: Record<string, unknown> | null
}

interface RunEvent {
  id: string
  run_id: string
  stage: string
  status: string
  batch_index: number | null
  rows_seen: number | null
  rows_written: number | null
  detail: Record<string, unknown> | null
  occurred_at: string
}

const STAGES = [
  'anchor_discovery',
  'touchpoint_sweep',
  'cross_channel_coalesce',
  'agent_infer',
  'decay_sweep',
  'validate',
] as const

function StatusPill({ status }: { status: string }) {
  const color =
    status === 'succeeded'
      ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
      : status === 'failed'
        ? 'bg-red-100 text-red-800 border-red-200'
        : status === 'skipped'
          ? 'bg-stone-100 text-stone-600 border-stone-200'
          : 'bg-amber-50 text-amber-700 border-amber-200'
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs ${color}`}
    >
      {status}
    </span>
  )
}

function StageDot({ stage, run }: { stage: string; run: RunSummary }) {
  const failed = run.stages_failed.includes(stage)
  const ok = run.stages_succeeded.includes(stage)
  if (failed) return <XCircle className="h-4 w-4 text-red-600" />
  if (ok) return <CheckCircle2 className="h-4 w-4 text-emerald-600" />
  return <Circle className="h-4 w-4 text-stone-300" />
}

export default function TracerRunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [runResult, setRunResult] = useState<string | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [runEvents, setRunEvents] = useState<RunEvent[]>([])
  const [loadingEvents, setLoadingEvents] = useState(false)

  const refresh = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/admin/tracer/status')
      if (!res.ok) {
        setError(`HTTP ${res.status}`)
        setRuns([])
      } else {
        const data = (await res.json()) as { runs: RunSummary[] }
        setRuns(data.runs ?? [])
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const loadEvents = async (runId: string) => {
    setSelectedRunId(runId)
    setLoadingEvents(true)
    try {
      const res = await fetch(`/api/admin/tracer/status?run_id=${encodeURIComponent(runId)}`)
      if (res.ok) {
        const data = (await res.json()) as { events: RunEvent[] }
        setRunEvents(data.events ?? [])
      } else {
        setRunEvents([])
      }
    } finally {
      setLoadingEvents(false)
    }
  }

  const triggerRun = async () => {
    setRunning(true)
    setRunResult(null)
    try {
      const res = await fetch('/api/admin/tracer/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      })
      if (!res.ok) {
        const text = await res.text()
        setRunResult(`Run failed: ${text}`)
      } else {
        const data = (await res.json()) as {
          summary: { run_id: string; status: string; totals: Record<string, number> }
        }
        setRunResult(
          `Run ${data.summary.run_id.slice(0, 8)}… ${data.summary.status} — ` +
            `signals=${data.summary.totals.signals_seen} ` +
            `tp=${data.summary.totals.touchpoints_written} ` +
            `frag=${data.summary.totals.fragments_written} ` +
            `cand=${data.summary.totals.candidate_matches_written}`,
        )
        await refresh()
      }
    } catch (e) {
      setRunResult(e instanceof Error ? e.message : String(e))
    } finally {
      setRunning(false)
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="font-serif text-3xl text-stone-900">Tracer runs</h1>
          <p className="mt-2 text-sm text-stone-600">
            Identity-First Phase B Backwards Tracer. Walks every connected
            channel and reconstructs the couples / touchpoints / fragments
            graph. Doctrine anchor: <code>IDENTITY-FIRST-ARCHITECTURE.md</code>{' '}
            §4.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-2 rounded-md border border-stone-300 bg-white px-3 py-2 text-sm hover:bg-stone-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={triggerRun}
            disabled={running}
            className="flex items-center gap-2 rounded-md bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
          >
            <Play className={`h-4 w-4 ${running ? 'animate-pulse' : ''}`} />
            {running ? 'Running' : 'Run now'}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <div>
            <strong>Error:</strong> {error}
          </div>
        </div>
      )}

      {runResult && (
        <div className="mb-6 rounded-md border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
          {runResult}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
        <table className="w-full text-sm">
          <thead className="border-b border-stone-200 bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-600">
            <tr>
              <th className="px-4 py-3">Run</th>
              <th className="px-4 py-3">When</th>
              <th className="px-4 py-3">Latest</th>
              <th className="px-4 py-3">Stages</th>
              <th className="px-4 py-3 text-right">Signals</th>
              <th className="px-4 py-3 text-right">TP / Frag / Cand</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-sm text-stone-500">
                  No runs yet. Press "Run now" to start one.
                </td>
              </tr>
            )}
            {runs.map((r) => {
              const totals = (r.totals ?? {}) as {
                signals_seen?: number
                touchpoints_written?: number
                fragments_written?: number
                candidate_matches_written?: number
              }
              return (
                <tr
                  key={r.run_id}
                  className={`cursor-pointer border-t border-stone-100 hover:bg-stone-50 ${
                    selectedRunId === r.run_id ? 'bg-stone-50' : ''
                  }`}
                  onClick={() => loadEvents(r.run_id)}
                >
                  <td className="px-4 py-3 font-mono text-xs text-stone-700">
                    {r.run_id.slice(0, 8)}…
                  </td>
                  <td className="px-4 py-3 text-stone-600">
                    {new Date(r.latest_event_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.latest_stage}</span>
                      <StatusPill status={r.latest_status} />
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      {STAGES.map((s) => (
                        <span key={s} title={s}>
                          <StageDot stage={s} run={r} />
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-stone-600">
                    {(totals.signals_seen ?? 0).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-stone-600">
                    {(totals.touchpoints_written ?? 0).toLocaleString()} /{' '}
                    {(totals.fragments_written ?? 0).toLocaleString()} /{' '}
                    {(totals.candidate_matches_written ?? 0).toLocaleString()}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {selectedRunId && (
        <div className="mt-8 rounded-lg border border-stone-200 bg-white p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium text-stone-900">
              Event timeline · {selectedRunId.slice(0, 12)}…
            </h2>
            <button
              onClick={() => {
                setSelectedRunId(null)
                setRunEvents([])
              }}
              className="text-xs text-stone-500 hover:text-stone-900"
            >
              Close
            </button>
          </div>
          {loadingEvents ? (
            <div className="py-4 text-center text-sm text-stone-500">Loading…</div>
          ) : (
            <div className="space-y-1 text-xs font-mono">
              {runEvents.map((e) => (
                <div key={e.id} className="flex items-start gap-3 border-b border-stone-100 py-1">
                  <span className="w-44 shrink-0 text-stone-500">
                    {new Date(e.occurred_at).toLocaleTimeString()}
                  </span>
                  <span className="w-44 shrink-0 text-stone-700">{e.stage}</span>
                  <span className="w-24 shrink-0">
                    <StatusPill status={e.status} />
                  </span>
                  <span className="flex-1 text-stone-600">
                    {e.rows_seen !== null && `seen=${e.rows_seen} `}
                    {e.rows_written !== null && `wrote=${e.rows_written} `}
                    {e.detail && (
                      <span className="text-stone-400">
                        {JSON.stringify(e.detail).slice(0, 200)}
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {runEvents.length === 0 && (
                <div className="text-stone-500">No events.</div>
              )}
            </div>
          )}
        </div>
      )}

      <p className="mt-6 text-xs text-stone-500">
        Cold-start mode: a venue with zero booked-anchor couples short-circuits
        the run and emits <code>cold_start_needed</code> (per §4 Don't skip
        #4). Tracer reruns are idempotent —{' '}
        <code>UNIQUE(venue_id, channel, external_id)</code> on touchpoints /
        fragments means the second pass writes zero new rows.
      </p>
      <p className="mt-2 text-xs text-stone-500">
        Run IDs prefixed <code>live:</code> are Phase C Forwards Linker
        rollups — one row per venue per day, accumulating every live signal
        (inbound email, Calendly tour, storefront CSV) that routed through
        <code> linkSignal</code>. Batch Tracer runs (UUID-prefixed) walk
        history; live-linker rolls forward.
      </p>
    </div>
  )
}
