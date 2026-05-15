'use client'

/**
 * Reconstruction progress banner.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md Appendix A — Susan sees a
 * live progress surface ("Found 23 couples so far, processing
 * Gmail...") while the Backwards Tracer reconstructs her history,
 * and a completion note when it's done.
 *
 * Shows on /intel/couples (her doorway). Four states, derived from
 * /api/admin/tracer/status:
 *
 *   queued       venues.identity_tracer_requested_at is set but no
 *                batch run has started yet -> "Reconstruction queued".
 *   in_progress  a batch Tracer run's latest event is recent and the
 *                run hasn't reached validate-succeeded -> live stage.
 *   complete     a batch run finished within the last 24h and no run
 *                is queued -> "Reconstruction complete", dismissible.
 *   idle         nothing to show -> renders null.
 *
 * Polls every 12s while queued / in_progress; stops when idle/complete.
 *
 * Batch Tracer runs carry a UUID run_id; the live Forwards Linker uses
 * a `live:`-prefixed key. We filter to UUID runs so linker activity
 * doesn't masquerade as a reconstruction.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, CheckCircle2, Clock, X } from 'lucide-react'

interface RunSummary {
  run_id: string
  latest_event_at: string
  latest_stage: string
  latest_status: string
  stages_succeeded: string[]
  stages_failed: string[]
  totals: Record<string, number> | null
}

type BannerState =
  | { kind: 'idle' }
  | { kind: 'queued' }
  | { kind: 'in_progress'; stage: string; signals: number | null }
  | { kind: 'complete'; couples: number | null; touchpoints: number | null }

const STAGE_LABEL: Record<string, string> = {
  anchor_discovery: 'finding your booked couples',
  touchpoint_sweep: 'walking your channels for touchpoints',
  cross_channel_coalesce: 'connecting signals across channels',
  agent_infer: 'spotting planners and agents',
  decay_sweep: 'checking which couples have gone quiet',
  validate: 'finishing up',
}

function isBatchRun(runId: string): boolean {
  // Batch Tracer = UUID run_id. Linker / replay runs are prefixed.
  return !runId.includes(':')
}

function deriveState(
  runs: RunSummary[],
  tracerRequestedAt: string | null,
): BannerState {
  const batch = runs.filter((r) => isBatchRun(r.run_id))
  const latest = batch[0] ?? null
  const now = Date.now()

  // In progress: latest batch run, validate not yet succeeded, last
  // event within 15 minutes.
  if (latest) {
    const ageMs = now - Date.parse(latest.latest_event_at)
    const done = latest.stages_succeeded.includes('validate')
    if (!done && ageMs < 15 * 60_000) {
      return {
        kind: 'in_progress',
        stage: latest.latest_stage,
        signals:
          typeof latest.totals?.signals_seen === 'number'
            ? latest.totals.signals_seen
            : null,
      }
    }
    // Complete: validate succeeded within the last 24h, nothing queued.
    if (done && ageMs < 24 * 3600_000 && !tracerRequestedAt) {
      return {
        kind: 'complete',
        couples:
          typeof latest.totals?.anchors_seen === 'number'
            ? latest.totals.anchors_seen
            : null,
        touchpoints:
          typeof latest.totals?.touchpoints_written === 'number'
            ? latest.totals.touchpoints_written
            : null,
      }
    }
  }

  // Queued: marker set, no in-progress run picked it up yet.
  if (tracerRequestedAt) return { kind: 'queued' }

  return { kind: 'idle' }
}

export function ReconstructionStatusBanner() {
  const [state, setState] = useState<BannerState>({ kind: 'idle' })
  const [dismissed, setDismissed] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/tracer/status')
      if (res.ok) {
        const data = (await res.json()) as {
          runs: RunSummary[]
          tracer_requested_at: string | null
        }
        setState(deriveState(data.runs ?? [], data.tracer_requested_at ?? null))
      }
    } catch {
      // Transient — keep the last known state, try again next tick.
    }
  }, [])

  useEffect(() => {
    void poll()
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [poll])

  // Re-poll every 12s while there's live activity.
  useEffect(() => {
    if (state.kind === 'queued' || state.kind === 'in_progress') {
      timer.current = setTimeout(() => void poll(), 12_000)
      return () => {
        if (timer.current) clearTimeout(timer.current)
      }
    }
  }, [state, poll])

  if (dismissed || state.kind === 'idle') return null

  if (state.kind === 'queued') {
    return (
      <div className="mb-4 flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        <Clock className="h-4 w-4 shrink-0" />
        <span>
          <strong>Reconstruction queued.</strong> Bloom will start rebuilding
          your couples from history within a few minutes — you can keep
          working.
        </span>
      </div>
    )
  }

  if (state.kind === 'in_progress') {
    const label = STAGE_LABEL[state.stage] ?? state.stage.replace(/_/g, ' ')
    return (
      <div className="mb-4 flex items-center gap-2 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
        <span>
          <strong>Reconstructing your history</strong> — currently {label}
          {state.signals !== null && state.signals > 0 && (
            <> ({state.signals.toLocaleString()} signals processed)</>
          )}
          . This page updates as it runs.
        </span>
      </div>
    )
  }

  // complete
  return (
    <div className="mb-4 flex items-start justify-between gap-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        <span>
          <strong>Reconstruction complete.</strong>
          {state.couples !== null && state.couples > 0 && (
            <> {state.couples.toLocaleString()} booked couples anchored</>
          )}
          {state.touchpoints !== null && state.touchpoints > 0 && (
            <>, {state.touchpoints.toLocaleString()} touchpoints mapped</>
          )}
          . Every journey below is rebuilt from your real history.
        </span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 text-emerald-700 hover:text-emerald-900"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}
