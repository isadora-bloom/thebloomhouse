/**
 * Bloom House — Wave 7C hypothesis_validation_sweep service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7C closes the discovery loop)
 *   - bloom-wave4-5-6-master-plan.md (7C: validations are two Sonnet
 *     calls + a query, paced at 3 jobs per tick)
 *   - feedback_parallel_stream_safety.md (cron registration deferred to
 *     reconciliation stream — Wave 7C does NOT touch vercel.json,
 *     /api/cron/route.ts, or /lib/cron-auth.ts.)
 *
 * What this service does
 * ----------------------
 *   1. Drains up to 3 oldest queued jobs from hypothesis_validation_jobs
 *      (atomic claim). Each job runs runHypothesisValidation, which
 *      makes two Sonnet calls + executor query.
 *   2. Independently: drift-refresh enqueue. Picks discoveries whose
 *      validation_status is 'in_progress' AND most recent
 *      validation_completed_at is older than 7 days. The 24h dedupe
 *      in the enqueue helper skips any with active jobs.
 *   3. Time-boxed at 280s.
 *
 * Why 3 venues per tick
 * ---------------------
 * Each validation is two Sonnet calls — slightly cheaper than Wave 7A
 * (one Sonnet call) because the inputs are smaller, but still ~$0.05-
 * $0.15 each. Three per tick keeps the cron well under the function
 * ceiling and well under the LLM-budget per-minute soft cap.
 *
 * Failure isolation
 * -----------------
 * Every job runs in its own try/catch. A single failure NEVER aborts
 * the sweep. Errors land on hypothesis_validation_jobs.error_text.
 *
 * TODO_CRON_REGISTRATION — register 'hypothesis_validation_sweep'
 * --------------------------------------------------------------
 * Cron registration must land in:
 *   1. src/app/api/cron/route.ts: add 'hypothesis_validation_sweep' to
 *      the job dispatcher; case 'hypothesis_validation_sweep' returns
 *      runValidationSweep().
 *   2. src/lib/cron-auth.ts: add 'hypothesis_validation_sweep' to
 *      DESTRUCTIVE_JOBS so the cron auth shape mirrors
 *      discovery_engine_sweep / cohort_rollup_sweep.
 *   3. vercel.json: add a cron entry — weekly suggested
 *      ("0 9 * * 1" — Monday 9am UTC, after Wave 7A's 8am sweep so
 *      newly produced high-confidence discoveries can land in the
 *      queue and be drained the same week).
 *
 * All three files are owned by the reconciliation stream during Wave
 * 7C's parallel run with Wave 6D + Wave 8.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { runHypothesisValidation } from './run-validation'
import { enqueueHypothesisValidation } from './enqueue'

const MAX_JOBS_PER_TICK = 3
const MAX_DRIFT_PER_TICK = 6
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface QueuedJob {
  id: string
  venue_id: string
  discovery_id: string
  trigger_signal: string | null
}

export interface ValidationSweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  drift_enqueued: number
  total_cost_cents: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ jobId: string; discoveryId: string; error: string }>
}

export interface RunValidationSweepOptions {
  supabase?: SupabaseClient
  maxJobs?: number
  maxDrift?: number
  timeboxMs?: number
}

async function processQueuedJobs(
  supabase: SupabaseClient,
  startedAt: number,
  maxJobs: number,
  timeboxMs: number,
): Promise<{
  processed: number
  done: number
  failed: number
  totalCostCents: number
  failures: Array<{ jobId: string; discoveryId: string; error: string }>
  timeboxed: boolean
}> {
  const { data: jobsData } = await supabase
    .from('hypothesis_validation_jobs')
    .select('id, venue_id, discovery_id, trigger_signal')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(maxJobs)

  const jobs = (jobsData ?? []) as QueuedJob[]

  let processed = 0
  let done = 0
  let failed = 0
  let totalCostCents = 0
  let timeboxed = false
  const failures: Array<{ jobId: string; discoveryId: string; error: string }> = []

  for (const job of jobs) {
    if (Date.now() - startedAt >= timeboxMs) {
      timeboxed = true
      break
    }

    // Atomic claim — only proceed if the row is still 'queued'.
    const { data: claimed, error: claimErr } = await supabase
      .from('hypothesis_validation_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle()

    if (claimErr || !claimed) {
      // Another worker grabbed it (or it transitioned away). Skip.
      continue
    }

    processed += 1

    try {
      const result = await runHypothesisValidation(
        { discoveryId: job.discovery_id },
        { supabase },
      )
      totalCostCents += result.costCents
      await supabase
        .from('hypothesis_validation_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)
      done += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed += 1
      failures.push({
        jobId: job.id,
        discoveryId: job.discovery_id,
        error: message,
      })
      try {
        await supabase
          .from('hypothesis_validation_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error(
          '[hypothesis-validation-sweep] failed to mark job failed',
          { jobId: job.id, original: message, markErr },
        )
      }
    }
  }

  return { processed, done, failed, totalCostCents, failures, timeboxed }
}

interface DriftCandidate {
  discovery_id: string
  venue_id: string
  validation_completed_at: string | null
}

async function enqueueDriftRefresh(
  supabase: SupabaseClient,
  maxDrift: number,
): Promise<number> {
  const cutoffMs = Date.now() - DRIFT_AGE_MS

  // Pull in_progress discoveries (i.e. inconclusive / data_too_thin
  // verdicts that may flip as cohort grows) whose last validation
  // completed > 7 days ago. validation_completed_at IS NULL means a run
  // started but never finished — also worth re-validating.
  const { data: stale } = await supabase
    .from('intel_discoveries')
    .select('id, venue_id, validation_completed_at')
    .eq('validation_status', 'in_progress')
    .order('validation_completed_at', { ascending: true, nullsFirst: true })
    .limit(maxDrift * 5)

  const candidates: DriftCandidate[] = []
  for (const row of (stale ?? []) as Array<{
    id: string
    venue_id: string
    validation_completed_at: string | null
  }>) {
    if (row.validation_completed_at === null) {
      candidates.push({
        discovery_id: row.id,
        venue_id: row.venue_id,
        validation_completed_at: null,
      })
      continue
    }
    const t = Date.parse(row.validation_completed_at)
    if (Number.isFinite(t) && t < cutoffMs) {
      candidates.push({
        discovery_id: row.id,
        venue_id: row.venue_id,
        validation_completed_at: row.validation_completed_at,
      })
    }
  }

  if (candidates.length === 0) return 0

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueHypothesisValidation({
      discoveryId: c.discovery_id,
      venueId: c.venue_id,
      triggerSignal: 'drift_refresh',
      supabase,
    })
    if (!r.skipped) enqueued += 1
  }

  return enqueued
}

/**
 * Walks the validation queue + drift-refreshes in_progress discoveries
 * every 7 days. Time-boxed at 280s. 3 jobs per tick.
 */
export async function runValidationSweep(
  options: RunValidationSweepOptions = {},
): Promise<ValidationSweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const maxJobs = options.maxJobs ?? MAX_JOBS_PER_TICK
  const maxDrift = options.maxDrift ?? MAX_DRIFT_PER_TICK
  const timeboxMs = options.timeboxMs ?? TIMEBOX_MS
  const startedAt = Date.now()

  try {
    const sweep = await processQueuedJobs(
      supabase,
      startedAt,
      maxJobs,
      timeboxMs,
    )

    let driftEnqueued = 0
    try {
      driftEnqueued = await enqueueDriftRefresh(supabase, maxDrift)
    } catch (err) {
      console.warn(
        '[hypothesis-validation-sweep] drift-refresh enqueue failed',
        err instanceof Error ? err.message : err,
      )
    }

    return {
      ok: true,
      processed: sweep.processed,
      done: sweep.done,
      failed: sweep.failed,
      drift_enqueued: driftEnqueued,
      total_cost_cents: Math.round(sweep.totalCostCents * 10_000) / 10_000,
      timeboxed: sweep.timeboxed,
      duration_ms: Date.now() - startedAt,
      failures: sweep.failures.slice(0, 20),
    }
  } catch (err) {
    return {
      ok: false,
      processed: 0,
      done: 0,
      failed: 0,
      drift_enqueued: 0,
      total_cost_cents: 0,
      timeboxed: false,
      duration_ms: Date.now() - startedAt,
      failures: [
        {
          jobId: '__sweep__',
          discoveryId: '__sweep__',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }
}
