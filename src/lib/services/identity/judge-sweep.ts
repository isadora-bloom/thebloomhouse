/**
 * Wave 4 Phase 2 — identity-judge-sweep service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction)
 *   - bloom-wave4-identity-reconstruction.md (Phase 2 — this is the
 *     worker that drains identity_reconstruction_jobs)
 *
 * Why this is a service (not embedded in a route)
 * -----------------------------------------------
 * vercel.json sits at the 40-cron Pro-plan ceiling, so this sweep
 * piggy-backs on the multi-job dispatcher at /api/cron?job=
 * identity_judge_sweep. We ALSO ship a standalone route at
 * /api/cron/identity-judge-sweep for local-dev and ad-hoc ops curls
 * (the Phase 2 verification plan's curl test). Both call into this
 * shared service so the worker logic lives in one place.
 *
 * Behaviour
 * ---------
 *   1. Pulls up to 50 oldest queued jobs from
 *      identity_reconstruction_jobs.
 *   2. For each job: atomic claim (UPDATE WHERE status='queued') →
 *      reconstructCoupleIdentity → SET status='done' OR 'failed'.
 *   3. Independently: drift-refresh enqueue. Picks up to 5 stale
 *      profiles (last_reconstructed_at older than 7 days) and ENQUEUES
 *      them with trigger_signal='drift_refresh'. The 24h dedupe in the
 *      enqueue helper skips any with active jobs.
 *   4. Time-boxed at 280s (Vercel Pro 300s ceiling minus 20s buffer).
 *
 * Failure isolation
 * -----------------
 * Every job runs in its own try/catch. A single failure NEVER aborts
 * the sweep. Errors land on identity_reconstruction_jobs.error_text.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { reconstructCoupleIdentity } from './reconstruct'
import { enqueueIdentityReconstruction } from './enqueue-reconstruction'

const MAX_JOBS_PER_TICK = 50
const MAX_DRIFT_PER_TICK = 5
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface QueuedJob {
  id: string
  wedding_id: string
  venue_id: string
  trigger_signal: string | null
}

interface DriftCandidate {
  wedding_id: string
  venue_id: string
  last_reconstructed_at: string
}

export interface JudgeSweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  drift_enqueued: number
  total_cost_cents: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ jobId: string; weddingId: string; error: string }>
}

export interface RunJudgeSweepOptions {
  supabase?: SupabaseClient
  /** Override the per-tick job cap. Defaults to 50. */
  maxJobs?: number
  /** Override the drift-refresh budget. Defaults to 5. */
  maxDrift?: number
  /** Override the platform timebox. Defaults to 280_000 ms. */
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
  failures: Array<{ jobId: string; weddingId: string; error: string }>
  timeboxed: boolean
}> {
  const { data: jobsData } = await supabase
    .from('identity_reconstruction_jobs')
    .select('id, wedding_id, venue_id, trigger_signal')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(maxJobs)

  const jobs = (jobsData ?? []) as QueuedJob[]

  let processed = 0
  let done = 0
  let failed = 0
  let totalCostCents = 0
  let timeboxed = false
  const failures: Array<{ jobId: string; weddingId: string; error: string }> = []

  for (const job of jobs) {
    if (Date.now() - startedAt >= timeboxMs) {
      timeboxed = true
      break
    }

    // Atomic claim — only proceed if the row is still 'queued' at the
    // moment of update. Two concurrent ticks won't double-process.
    const { data: claimed, error: claimErr } = await supabase
      .from('identity_reconstruction_jobs')
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
      const result = await reconstructCoupleIdentity(job.wedding_id, { supabase })
      totalCostCents += result.costCents
      await supabase
        .from('identity_reconstruction_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)
      done += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed += 1
      failures.push({ jobId: job.id, weddingId: job.wedding_id, error: message })
      try {
        await supabase
          .from('identity_reconstruction_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error(
          '[identity-judge-sweep] failed to mark job failed',
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

  // Over-fetch 3x so the dedupe filter inside enqueueIdentityReconstruction
  // has room to skip already-active rows without starving the budget.
  const { data: stale } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id, venue_id, last_reconstructed_at')
    .lt('last_reconstructed_at', cutoff)
    .order('last_reconstructed_at', { ascending: true })
    .limit(maxDrift * 3)

  const candidates = (stale ?? []) as DriftCandidate[]
  if (candidates.length === 0) return 0

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueIdentityReconstruction({
      weddingId: c.wedding_id,
      venueId: c.venue_id,
      triggerSignal: 'drift_refresh',
      supabase,
    })
    if (!r.skipped) enqueued += 1
  }

  return enqueued
}

export async function runIdentityJudgeSweep(
  options: RunJudgeSweepOptions = {},
): Promise<JudgeSweepResult> {
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
        '[identity-judge-sweep] drift-refresh enqueue failed',
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
          weddingId: '__sweep__',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }
}
