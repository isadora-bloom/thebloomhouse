/**
 * Bloom House — Wave 5B cohort-rollup-sweep service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5B aggregates the per-couple substrate
 *     into venue-level intel)
 *   - bloom-wave4-5-6-master-plan.md (5B: weekly cohort rollup, drift
 *     refresh trigger when last_refreshed_at < 7d old)
 *
 * TODO Wave 5B reconciliation: register 'cohort_rollup_sweep' job in
 * src/app/api/cron/route.ts dispatcher + add to DESTRUCTIVE_JOBS in
 * src/lib/cron-auth.ts (sequential reconciliation after Round 2 lands).
 *
 * Why this is a service (not embedded in a route)
 * -----------------------------------------------
 * vercel.json sits at the 40-cron Pro-plan ceiling, so this sweep
 * piggy-backs on the multi-job dispatcher at /api/cron?job=
 * cohort_rollup_sweep. Mirrors Wave 4 + 5A sweep patterns.
 *
 * Behaviour
 * ---------
 *   1. Pulls up to 5 oldest queued jobs from venue_intel_jobs (per-
 *      venue volume is low — one rollup per venue per week).
 *   2. For each job: atomic claim (UPDATE WHERE status='queued') →
 *      runCohortRollup → SET status='done' OR 'failed'.
 *   3. Independently: drift-refresh enqueue. Picks venues whose
 *      last_refreshed_at is older than 7 days and ENQUEUES them with
 *      trigger_signal='drift_refresh'. The 24h dedupe in the enqueue
 *      helper skips any with active jobs.
 *   4. Time-boxed at 280s (Vercel Pro 300s ceiling minus 20s buffer).
 *
 * Failure isolation
 * -----------------
 * Every job runs in its own try/catch. A single failure NEVER aborts
 * the sweep. Errors land on venue_intel_jobs.error_text.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { runCohortRollup } from './cohort-rollup'
import { enqueueCohortRollup } from './enqueue-cohort-rollup'

const MAX_JOBS_PER_TICK = 5
const MAX_DRIFT_PER_TICK = 10
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface QueuedJob {
  id: string
  venue_id: string
  trigger_signal: string | null
}

interface DriftCandidate {
  venue_id: string
  last_refreshed_at: string
}

export interface CohortRollupSweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  drift_enqueued: number
  total_cost_cents: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ jobId: string; venueId: string; error: string }>
}

export interface RunCohortRollupSweepOptions {
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
  failures: Array<{ jobId: string; venueId: string; error: string }>
  timeboxed: boolean
}> {
  const { data: jobsData } = await supabase
    .from('venue_intel_jobs')
    .select('id, venue_id, trigger_signal')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(maxJobs)

  const jobs = (jobsData ?? []) as QueuedJob[]

  let processed = 0
  let done = 0
  let failed = 0
  let totalCostCents = 0
  let timeboxed = false
  const failures: Array<{ jobId: string; venueId: string; error: string }> = []

  for (const job of jobs) {
    if (Date.now() - startedAt >= timeboxMs) {
      timeboxed = true
      break
    }

    // Atomic claim — only proceed if the row is still 'queued' at the
    // moment of update. Two concurrent ticks won't double-process.
    const { data: claimed, error: claimErr } = await supabase
      .from('venue_intel_jobs')
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
      const result = await runCohortRollup(job.venue_id, { supabase })
      totalCostCents += result.costCents
      await supabase
        .from('venue_intel_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)
      done += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed += 1
      failures.push({ jobId: job.id, venueId: job.venue_id, error: message })
      try {
        await supabase
          .from('venue_intel_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error(
          '[cohort-rollup-sweep] failed to mark job failed',
          { jobId: job.id, original: message, markErr },
        )
      }
    }
  }

  return { processed, done, failed, totalCostCents, failures, timeboxed }
}

async function enqueueDriftRefresh(
  supabase: SupabaseClient,
  maxDrift: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_MS).toISOString()

  // Over-fetch 3x so the dedupe filter inside enqueueCohortRollup has
  // room to skip already-active rows without starving the budget.
  const { data: stale } = await supabase
    .from('venue_intel')
    .select('venue_id, last_refreshed_at')
    .lt('last_refreshed_at', cutoff)
    .order('last_refreshed_at', { ascending: true })
    .limit(maxDrift * 3)

  const candidates = (stale ?? []) as DriftCandidate[]

  // Also enqueue venues that have NO venue_intel row yet (cold-start
  // path). A venue with profiles + intel but no rollup should land in
  // the queue on first tick.
  const { data: cold } = await supabase
    .from('couple_identity_profile')
    .select('venue_id')
    .limit(maxDrift * 5)

  const seenIds = new Set<string>(candidates.map((c) => c.venue_id))
  const coldRows = (cold ?? []) as { venue_id: string }[]
  for (const row of coldRows) {
    if (seenIds.has(row.venue_id)) continue
    // Check if the venue already has a rollup; if not, treat it as
    // drift-eligible.
    const { data: existing } = await supabase
      .from('venue_intel')
      .select('venue_id')
      .eq('venue_id', row.venue_id)
      .maybeSingle()
    if (!existing) {
      candidates.push({
        venue_id: row.venue_id,
        last_refreshed_at: '1970-01-01T00:00:00.000Z',
      })
      seenIds.add(row.venue_id)
    }
    if (candidates.length >= maxDrift * 3) break
  }

  if (candidates.length === 0) return 0

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueCohortRollup({
      venueId: c.venue_id,
      triggerSignal: 'drift_refresh',
      supabase,
    })
    if (!r.skipped) enqueued += 1
  }

  return enqueued
}

export async function runCohortRollupSweep(
  options: RunCohortRollupSweepOptions = {},
): Promise<CohortRollupSweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const maxJobs = options.maxJobs ?? MAX_JOBS_PER_TICK
  const maxDrift = options.maxDrift ?? MAX_DRIFT_PER_TICK
  const timeboxMs = options.timeboxMs ?? TIMEBOX_MS
  const startedAt = Date.now()

  try {
    const sweep = await processQueuedJobs(supabase, startedAt, maxJobs, timeboxMs)

    let driftEnqueued = 0
    try {
      driftEnqueued = await enqueueDriftRefresh(supabase, maxDrift)
    } catch (err) {
      console.warn(
        '[cohort-rollup-sweep] drift-refresh enqueue failed',
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
          venueId: '__sweep__',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }
}
