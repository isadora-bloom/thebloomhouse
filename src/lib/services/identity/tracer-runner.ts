/**
 * Phase B Tracer runner + auto-trigger queue.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 + Appendix A.
 *
 * Entry shapes
 * ------------
 *   runIdentityFirstTracerForVenue(venueId) — runs the Tracer for one
 *       venue with full lifecycle: a "started" operator notification,
 *       the run, marker clearing on terminal success, and a "done" /
 *       "cold-start" notification. Called by the manual /admin/tracer
 *       endpoint AND by the cron drain.
 *   runIdentityFirstTracerAllVenues() — fleet-wide run (manual escape
 *       hatch; the per-venue drain is the normal path).
 *   requestTracerRun(venueId) — stamps venues.identity_tracer_requested_at
 *       so the drain picks the venue up. Called by importers.
 *   drainPendingTracerRun() — cron entry. Picks the oldest venue with a
 *       pending marker, runs the Tracer for it. One venue per tick.
 *
 * The marker lifecycle (migration 350)
 * ------------------------------------
 *   import finishes      -> requestTracerRun stamps identity_tracer_requested_at
 *   5-minute cron drain  -> picks oldest stamped venue, runs the Tracer
 *   Tracer reaches a terminal state (succeeded / cold_start_needed)
 *                        -> marker cleared
 *   Tracer failed        -> marker left set, next drain tick retries
 */

import { createServiceClient } from '@/lib/supabase/service'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'
import { createNotification } from '@/lib/services/admin-notifications'
import { runTracer, type TracerSummary, type TracerOptions } from './tracer'

export interface IdentityTracerRunResult {
  venues_attempted: number
  venues_succeeded: number
  venues_cold_start: number
  venues_failed: number
  per_venue: TracerSummary[]
  duration_ms: number
}

// ---------------------------------------------------------------------------
// Auto-trigger queue
// ---------------------------------------------------------------------------

/**
 * Mark a venue as needing a Backwards Tracer run. Called by importers
 * (brain-dump CSV, Gmail sync) the moment new identity-relevant data
 * lands. Idempotent — re-stamping just pushes the request time
 * forward, which is harmless (the drain picks the oldest marker).
 *
 * Never throws: a failure to stamp must not fail the import itself.
 */
export async function requestTracerRun(
  supabase: SupabaseClient,
  venueId: string,
): Promise<void> {
  try {
    await supabase
      .from('venues')
      .update({ identity_tracer_requested_at: new Date().toISOString() })
      .eq('id', venueId)
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'tracer_runner.request_failed',
      venueId,
      data: { error: err instanceof Error ? err.message : String(err) },
    })
  }
}

/**
 * Cron drain. Picks the single oldest venue with a pending marker and
 * runs the Tracer for it. One venue per tick keeps each cron
 * invocation inside its time budget; a backlog drains one venue every
 * 5 minutes.
 *
 * In-progress guard: if the venue already has a tracer_run_events row
 * in the last 8 minutes, a run is active (or just settled) — skip this
 * tick rather than starting a concurrent sweep.
 */
export async function drainPendingTracerRun(): Promise<{
  drained: string | null
  skipped_reason?: string
}> {
  const supabase = createServiceClient()

  const { data: pending } = await supabase
    .from('venues')
    .select('id, identity_tracer_requested_at')
    .not('identity_tracer_requested_at', 'is', null)
    .order('identity_tracer_requested_at', { ascending: true })
    .limit(1)
  const venue = ((pending ?? []) as Array<{ id: string }>)[0]
  if (!venue) return { drained: null, skipped_reason: 'no_pending' }

  // In-progress guard.
  const eightMinAgo = new Date(Date.now() - 8 * 60_000).toISOString()
  const { count: recentEvents } = await supabase
    .from('tracer_run_events')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venue.id)
    .gte('occurred_at', eightMinAgo)
  if ((recentEvents ?? 0) > 0) {
    return { drained: null, skipped_reason: 'run_in_progress' }
  }

  await runIdentityFirstTracerForVenue(venue.id)
  return { drained: venue.id }
}

// ---------------------------------------------------------------------------
// Per-venue run with operator-visible lifecycle
// ---------------------------------------------------------------------------

async function notifyReconstruction(
  venueId: string,
  phase: 'started' | 'done' | 'cold_start',
  summary?: TracerSummary,
): Promise<void> {
  try {
    if (phase === 'started') {
      // Dedupe: skip if a "started" notification fired in the last
      // 20 minutes (guards against a drain double-pick).
      const supabase = createServiceClient()
      const twentyMinAgo = new Date(Date.now() - 20 * 60_000).toISOString()
      const { count } = await supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('type', 'identity_reconstruction_started')
        .gte('created_at', twentyMinAgo)
      if ((count ?? 0) > 0) return
      await createNotification({
        venueId,
        type: 'identity_reconstruction_started',
        title: 'Reconstructing your history',
        body: 'Bloom is walking your connected channels to rebuild every couple’s journey. This runs in the background — you can keep working.',
        priority: 'normal',
      })
    } else if (phase === 'done') {
      const t = summary?.totals
      await createNotification({
        venueId,
        type: 'identity_reconstruction_done',
        title: 'Your history is ready to explore',
        body: t
          ? `Reconstruction complete. ${t.signals_seen.toLocaleString()} signals processed, ${t.touchpoints_written.toLocaleString()} touchpoints mapped. Open Couples to see the journeys.`
          : 'Reconstruction complete. Open Couples to see the journeys.',
        priority: 'high',
      })
    } else {
      await createNotification({
        venueId,
        type: 'identity_reconstruction_cold_start',
        title: 'Add your booked couples to begin',
        body: 'We could not find any booked clients to anchor reconstruction on. Add 5–10 booked couples (names + wedding dates) and reconstruction will start automatically.',
        priority: 'high',
      })
    }
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'tracer_runner.notify_failed',
      venueId,
      data: { phase, error: err instanceof Error ? err.message : String(err) },
    })
  }
}

export async function runIdentityFirstTracerForVenue(
  venueId: string,
  opts?: Partial<Omit<TracerOptions, 'venueId' | 'supabase'>>,
): Promise<TracerSummary> {
  const supabase = createServiceClient()

  await notifyReconstruction(venueId, 'started')

  const summary = await runTracer({ venueId, supabase, ...opts })

  // Terminal states clear the queue marker. A failed run leaves it set
  // so the next drain tick retries.
  if (summary.status === 'succeeded' || summary.status === 'cold_start_needed') {
    await supabase
      .from('venues')
      .update({ identity_tracer_requested_at: null })
      .eq('id', venueId)
  }

  if (summary.status === 'succeeded') {
    await notifyReconstruction(venueId, 'done', summary)
  } else if (summary.status === 'cold_start_needed') {
    await notifyReconstruction(venueId, 'cold_start', summary)
  }

  return summary
}

export async function runIdentityFirstTracerAllVenues(
  opts?: Partial<Omit<TracerOptions, 'venueId' | 'supabase'>>,
): Promise<IdentityTracerRunResult> {
  const start = Date.now()
  const supabase = createServiceClient()

  const { data: venues, error } = await supabase
    .from('venues')
    .select('id, name')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`tracer-runner: venue lookup ${error.message}`)

  const result: IdentityTracerRunResult = {
    venues_attempted: 0,
    venues_succeeded: 0,
    venues_cold_start: 0,
    venues_failed: 0,
    per_venue: [],
    duration_ms: 0,
  }

  for (const v of ((venues ?? []) as Array<{ id: string; name: string | null }>)) {
    result.venues_attempted += 1
    try {
      const s = await runIdentityFirstTracerForVenue(v.id, opts)
      result.per_venue.push(s)
      if (s.status === 'succeeded') result.venues_succeeded += 1
      else if (s.status === 'cold_start_needed') result.venues_cold_start += 1
      else result.venues_failed += 1
    } catch (err) {
      result.venues_failed += 1
      logEvent({
        level: 'error',
        msg: 'tracer_runner.venue_failed',
        venueId: v.id,
        data: {
          venue_name: v.name,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  result.duration_ms = Date.now() - start
  logEvent({
    level: 'info',
    msg: 'tracer_runner.fleet_complete',
    data: {
      duration_ms: result.duration_ms,
      attempted: result.venues_attempted,
      succeeded: result.venues_succeeded,
      cold_start: result.venues_cold_start,
      failed: result.venues_failed,
    },
  })
  return result
}
