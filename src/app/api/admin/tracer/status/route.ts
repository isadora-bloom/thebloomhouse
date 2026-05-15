/**
 * GET /api/admin/tracer/status
 *
 * Returns the most recent Tracer runs for the caller's venue (or
 * any venue if super_admin), with per-stage event timelines and
 * current totals. Read-only.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 ("Each stage emits
 * structured events to tracer_run_events table for operator-
 * visible progress").
 *
 * Query
 * -----
 *   ?run_id=<uuid>     — single-run detail. Returns full event log.
 *   ?venue_id=<uuid>   — scope; super_admin only when set to a
 *                         non-self venue.
 *   (no run_id)        — list recent runs (last 20) for the venue.
 *
 * Returns
 * -------
 *   200 { run_id, events: TracerRunEvent[] }  when run_id set
 *   200 { runs: Array<{ run_id, latest_event_at, latest_status, stages_complete }> }
 *       when listing
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

interface EventRow {
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

function resolveScope(
  auth: NonNullable<Awaited<ReturnType<typeof getPlatformAuth>>>,
  paramVenueId: string | null,
): { venueId: string | null; allowed: boolean } {
  const role = (auth.role ?? 'coordinator') as string
  const isSuper =
    auth.isDemo || role === 'super_admin' || role === 'org_admin'
  if (paramVenueId) {
    if (!isSuper && paramVenueId !== auth.venueId) {
      return { venueId: null, allowed: false }
    }
    return { venueId: paramVenueId, allowed: true }
  }
  return { venueId: auth.venueId, allowed: true }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const { searchParams } = new URL(req.url)
  const runId = searchParams.get('run_id')
  const paramVenue = searchParams.get('venue_id')

  const scope = resolveScope(auth, paramVenue)
  if (!scope.allowed) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  if (!scope.venueId) {
    return NextResponse.json(
      { error: 'venue_id required (no venue in auth context)' },
      { status: 400 },
    )
  }

  const supabase = createServiceClient()

  if (runId) {
    const { data, error } = await supabase
      .from('tracer_run_events')
      .select(
        'id, run_id, stage, status, batch_index, rows_seen, rows_written, detail, occurred_at',
      )
      .eq('venue_id', scope.venueId)
      .eq('run_id', runId)
      .order('occurred_at', { ascending: true })
    if (error) {
      return NextResponse.json(
        { error: 'lookup_failed', detail: error.message },
        { status: 500 },
      )
    }
    return NextResponse.json({ run_id: runId, events: (data ?? []) as EventRow[] })
  }

  // List recent runs: most recent 20 distinct run_ids.
  const { data, error } = await supabase
    .from('tracer_run_events')
    .select('run_id, stage, status, occurred_at, detail')
    .eq('venue_id', scope.venueId)
    .order('occurred_at', { ascending: false })
    .limit(200)
  if (error) {
    return NextResponse.json(
      { error: 'lookup_failed', detail: error.message },
      { status: 500 },
    )
  }
  type RunRow = {
    run_id: string
    stage: string
    status: string
    occurred_at: string
    detail: Record<string, unknown> | null
  }
  const rows = (data ?? []) as RunRow[]
  const byRun = new Map<
    string,
    {
      run_id: string
      latest_event_at: string
      latest_stage: string
      latest_status: string
      stages_succeeded: Set<string>
      stages_failed: Set<string>
      totals: Record<string, unknown> | null
    }
  >()
  // Per-run aggregator. For batch Tracer runs, totals come from the
  // 'validate' stage detail.run_totals. For Phase C live-linker runs
  // (stage='forwards_link'), there's no validate stage — totals are
  // accumulated per-event from the action types, so the dashboard
  // sees signals_seen / touchpoints_written / etc. for the day.
  const linkerTotalsByRun = new Map<
    string,
    {
      signals_seen: number
      touchpoints_written: number
      fragments_written: number
      candidate_matches_written: number
      judge_calls: number
    }
  >()
  for (const r of rows) {
    const cur =
      byRun.get(r.run_id) ?? {
        run_id: r.run_id,
        latest_event_at: r.occurred_at,
        latest_stage: r.stage,
        latest_status: r.status,
        stages_succeeded: new Set<string>(),
        stages_failed: new Set<string>(),
        totals: null,
      }
    if (r.status === 'succeeded') cur.stages_succeeded.add(r.stage)
    if (r.status === 'failed') cur.stages_failed.add(r.stage)
    if (r.stage === 'validate' && r.detail && (r.detail as Record<string, unknown>).run_totals) {
      cur.totals = (r.detail as Record<string, unknown>).run_totals as Record<string, unknown>
    }
    const isLinkerRow =
      r.stage === 'forwards_link' ||
      ((r.detail as Record<string, unknown> | null)?.kind === 'live_linker')
    if (isLinkerRow) {
      const acc =
        linkerTotalsByRun.get(r.run_id) ?? {
          signals_seen: 0,
          touchpoints_written: 0,
          fragments_written: 0,
          candidate_matches_written: 0,
          judge_calls: 0,
        }
      acc.signals_seen += 1
      const detail = (r.detail ?? {}) as Record<string, unknown>
      const action = detail.action as string | undefined
      if (action === 'attached' || action === 'candidate_medium' || action === 'candidate_low') {
        acc.touchpoints_written += 1
      }
      if (action === 'fragment' || action === 'cold_start') acc.fragments_written += 1
      if (action === 'candidate_medium' || action === 'candidate_low') {
        acc.candidate_matches_written += 1
      }
      if (detail.judge_invoked) acc.judge_calls += 1
      linkerTotalsByRun.set(r.run_id, acc)
    }
    byRun.set(r.run_id, cur)
  }
  // Apply linker-derived totals.
  for (const [runId, totals] of linkerTotalsByRun) {
    const entry = byRun.get(runId)
    if (entry && !entry.totals) entry.totals = totals
  }
  const runs = Array.from(byRun.values())
    .slice(0, 20)
    .map((r) => ({
      run_id: r.run_id,
      latest_event_at: r.latest_event_at,
      latest_stage: r.latest_stage,
      latest_status: r.latest_status,
      stages_succeeded: Array.from(r.stages_succeeded),
      stages_failed: Array.from(r.stages_failed),
      totals: r.totals,
    }))

  return NextResponse.json({ runs })
}
