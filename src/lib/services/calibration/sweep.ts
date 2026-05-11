/**
 * Wave 18 — Calibration sweep.
 *
 * Anchor: feedback_measure_dont_assume.md
 *
 * What this does
 * --------------
 * Drains the measure_outcome_jobs queue + does a daily catch-up
 * pass on dangling snapshots without outcomes for every venue.
 *
 * Two phases per run:
 *
 *   1) Queue drain. Pop up to BATCH_SIZE queued jobs and call
 *      measureOutcomes(weddingId) for each. Mark done / failed.
 *
 *   2) Catch-up. Across every venue with at least one
 *      prediction_snapshot in the last 30 days, call measureOutcomes
 *      with venueId scope. Catches the case where a lifecycle
 *      transition happened but the trigger-fan-out failed to enqueue.
 *
 * Cron wiring: TODO cron 'calibration_sweep' (registered separately;
 * cron route file is in another wave's zone).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { measureOutcomes } from './measure-outcomes'

const BATCH_SIZE = 50
const CATCHUP_WINDOW_DAYS = 30

export interface SweepResult {
  ok: boolean
  jobsDrained: number
  jobsFailed: number
  catchupVenues: number
  catchupMeasured: number
  catchupSkipped: number
  errors: string[]
}

export async function runCalibrationSweep(
  options: { supabase?: SupabaseClient; limit?: number } = {},
): Promise<SweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const limit = Math.max(1, Math.min(500, options.limit ?? BATCH_SIZE))
  const errors: string[] = []

  // ----- Phase 1: queue drain -----
  let jobsDrained = 0
  let jobsFailed = 0

  const { data: queued, error: qErr } = await supabase
    .from('measure_outcome_jobs')
    .select('id, wedding_id, venue_id')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(limit)
  if (qErr) {
    errors.push(`queue fetch failed: ${qErr.message}`)
  } else if (queued && queued.length > 0) {
    for (const job of queued as Array<{
      id: string
      wedding_id: string
      venue_id: string
    }>) {
      // Best-effort transition to running. We don't atomically lock;
      // the UNIQUE index on prediction_outcomes.prediction_snapshot_id
      // already protects the data side, so a second runner picking up
      // the same job just no-ops.
      await supabase
        .from('measure_outcome_jobs')
        .update({ status: 'running', started_at: new Date().toISOString() })
        .eq('id', job.id)

      const result = await measureOutcomes({
        venueId: job.venue_id,
        weddingId: job.wedding_id,
        supabase,
      })

      if (!result.ok) {
        jobsFailed++
        errors.push(`job ${job.id} failed: ${result.reason ?? 'unknown'}`)
        await supabase
          .from('measure_outcome_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: result.reason ?? null,
          })
          .eq('id', job.id)
        continue
      }

      jobsDrained++
      await supabase
        .from('measure_outcome_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
          snapshots_measured: result.measured.length,
        })
        .eq('id', job.id)
    }
  }

  // ----- Phase 2: catch-up pass -----
  // Find every venue that has at least one snapshot in the catch-up
  // window. Run measureOutcomes per-venue.
  const sinceIso = new Date(
    Date.now() - CATCHUP_WINDOW_DAYS * 86_400_000,
  ).toISOString()
  const { data: recentSnaps, error: rsErr } = await supabase
    .from('prediction_snapshots')
    .select('venue_id')
    .gte('snapshotted_at', sinceIso)
    .limit(5000)
  if (rsErr) {
    errors.push(`catchup snapshot scan failed: ${rsErr.message}`)
    return {
      ok: errors.length === 0,
      jobsDrained,
      jobsFailed,
      catchupVenues: 0,
      catchupMeasured: 0,
      catchupSkipped: 0,
      errors,
    }
  }

  const venueIds = Array.from(
    new Set((recentSnaps ?? []).map((r) => (r as { venue_id: string }).venue_id)),
  )

  let catchupMeasured = 0
  let catchupSkipped = 0
  for (const venueId of venueIds) {
    const result = await measureOutcomes({ venueId, supabase, limit: 200 })
    if (!result.ok) {
      errors.push(`catchup venue ${venueId} failed: ${result.reason ?? 'unknown'}`)
      continue
    }
    catchupMeasured += result.measured.length
    catchupSkipped += result.skipped
  }

  return {
    ok: errors.length === 0,
    jobsDrained,
    jobsFailed,
    catchupVenues: venueIds.length,
    catchupMeasured,
    catchupSkipped,
    errors,
  }
}
