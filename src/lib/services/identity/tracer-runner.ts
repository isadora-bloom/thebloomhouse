/**
 * Phase B Tracer all-venue runner.
 *
 * Wraps `runTracer` with a venue iteration loop, per-venue error
 * isolation, and a top-level summary suitable for cron telemetry.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 + Appendix A.
 *
 * Two entry shapes
 * ----------------
 *   runIdentityFirstTracerAllVenues()       — fleet-wide nightly run.
 *   runIdentityFirstTracerForVenue(venueId) — on-demand operator
 *                                              trigger or test run.
 *
 * Both return the same TracerSummary[]. Per-venue exceptions are
 * caught + logged + counted; one venue failing does not stop the
 * fleet.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'
import { runTracer, type TracerSummary, type TracerOptions } from './tracer'

export interface IdentityTracerRunResult {
  venues_attempted: number
  venues_succeeded: number
  venues_cold_start: number
  venues_failed: number
  per_venue: TracerSummary[]
  duration_ms: number
}

export async function runIdentityFirstTracerForVenue(
  venueId: string,
  opts?: Partial<Omit<TracerOptions, 'venueId' | 'supabase'>>,
): Promise<TracerSummary> {
  const supabase = createServiceClient()
  return runTracer({
    venueId,
    supabase,
    ...opts,
  })
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
      const s = await runTracer({
        venueId: v.id,
        supabase,
        ...opts,
      })
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
