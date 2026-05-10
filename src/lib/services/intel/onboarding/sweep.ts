/**
 * Bloom House — Wave 5D venue-thesis sweep service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D thesis is the onboarding bootstrap;
 *     refresh weekly + at every 25-couple cohort milestone)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *   - feedback_parallel_stream_safety.md (Wave 5D's job-string is
 *     'venue_thesis_sweep'; reconciliation stream wires the cron + auth)
 *
 * TODO Wave 5D reconciliation: register 'venue_thesis_sweep' job in
 * src/app/api/cron/route.ts dispatcher + add to DESTRUCTIVE_JOBS in
 * src/lib/cron-auth.ts (sequential reconciliation after parallel waves
 * land). Also add a cron schedule entry to vercel.json (weekly is fine
 * — daily would be wasted spend on a venue-shaped job).
 *
 * Why this is a service (not embedded in a route)
 * -----------------------------------------------
 * vercel.json sits at the 40-cron Pro-plan ceiling, so this sweep
 * piggy-backs on the multi-job dispatcher at /api/cron?job=
 * venue_thesis_sweep. Mirrors Wave 5B's cohort-rollup-sweep.
 *
 * Behaviour
 * ---------
 *   1. Drains up to 5 oldest queued jobs from venue_thesis_jobs (per-
 *      venue volume is low — one thesis per venue per week).
 *   2. For each job: atomic claim (UPDATE WHERE status='queued') →
 *      generateVenueThesis → SET status='done' OR 'failed'.
 *   3. Drift-refresh enqueue: picks venues whose last_generated_at is
 *      older than 7 days OR whose cohort has grown ≥25% since last
 *      generation, and ENQUEUES them with trigger_signal=
 *      'weekly_drift'.
 *   4. Time-boxed at 280s (Vercel Pro 300s ceiling minus 20s buffer).
 *
 * Failure isolation
 * -----------------
 * Every job runs in its own try/catch. A single failure NEVER aborts
 * the sweep. Errors land on venue_thesis_jobs.error_text.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { generateVenueThesis } from './generate-thesis'

const MAX_JOBS_PER_TICK = 5
const MAX_DRIFT_PER_TICK = 10
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
const COHORT_GROWTH_THRESHOLD = 0.25 // 25%
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

interface QueuedJob {
  id: string
  venue_id: string
  trigger_signal: string | null
}

interface DriftCandidate {
  venue_id: string
  last_generated_at: string
  couples_at_generation: number
}

export interface VenueThesisSweepResult {
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

export interface RunVenueThesisSweepOptions {
  supabase?: SupabaseClient
  maxJobs?: number
  maxDrift?: number
  timeboxMs?: number
}

// ---------------------------------------------------------------------------
// Enqueue helper (kept here so the sweep can populate the queue without
// a separate file; mirrors the Wave 5B style).
// ---------------------------------------------------------------------------

interface EnqueueArgs {
  venueId: string
  triggerSignal: string
  supabase: SupabaseClient
}

interface EnqueueResult {
  jobId?: string
  skipped: boolean
  reason?: string
}

/**
 * Enqueue a venue-thesis job. 24h dedupe: if a job exists for this
 * venue within the last 24 hours and is still queued or running, skip.
 *
 * TODO: when couple_identity_profile inserts cross multiples of 25
 * (25/50/75/100) for a venue, call this with triggerSignal=
 * 'cohort_milestone'. Reconciliation stream wires that — Wave 5D
 * service does NOT touch reconstruct.ts.
 */
export async function enqueueVenueThesis(
  args: EnqueueArgs,
): Promise<EnqueueResult> {
  const { venueId, triggerSignal, supabase } = args
  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()
  const { data: existing } = await supabase
    .from('venue_thesis_jobs')
    .select('id, status')
    .eq('venue_id', venueId)
    .gte('enqueued_at', sinceIso)
    .in('status', ['queued', 'running'])
    .limit(1)
    .maybeSingle()
  if (existing) {
    return { skipped: true, reason: 'dedupe_24h' }
  }
  const { data: inserted, error } = await supabase
    .from('venue_thesis_jobs')
    .insert({
      venue_id: venueId,
      status: 'queued',
      trigger_signal: triggerSignal,
    })
    .select('id')
    .maybeSingle()
  if (error || !inserted) {
    return { skipped: true, reason: error?.message ?? 'insert_failed' }
  }
  return { jobId: (inserted as { id: string }).id, skipped: false }
}

// ---------------------------------------------------------------------------
// Process queued jobs
// ---------------------------------------------------------------------------

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
    .from('venue_thesis_jobs')
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

    // Atomic claim — only proceed if the row is still 'queued'.
    const { data: claimed, error: claimErr } = await supabase
      .from('venue_thesis_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle()

    if (claimErr || !claimed) continue

    processed += 1

    try {
      const result = await generateVenueThesis(job.venue_id, { supabase })
      totalCostCents += result.costCents
      await supabase
        .from('venue_thesis_jobs')
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
          .from('venue_thesis_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error(
          '[venue-thesis-sweep] failed to mark job failed',
          { jobId: job.id, original: message, markErr },
        )
      }
    }
  }

  return { processed, done, failed, totalCostCents, failures, timeboxed }
}

// ---------------------------------------------------------------------------
// Drift enqueue
// ---------------------------------------------------------------------------

async function enqueueDriftRefresh(
  supabase: SupabaseClient,
  maxDrift: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_MS).toISOString()

  const { data: stale } = await supabase
    .from('venue_thesis')
    .select('venue_id, last_generated_at, couples_at_generation')
    .lt('last_generated_at', cutoff)
    .order('last_generated_at', { ascending: true })
    .limit(maxDrift * 3)

  const candidates = (stale ?? []) as DriftCandidate[]

  // Cohort-growth path: any venue whose CURRENT cohort size has grown
  // ≥25% since couples_at_generation also gets enqueued, even if it's
  // not yet 7 days stale.
  const { data: allTheses } = await supabase
    .from('venue_thesis')
    .select('venue_id, couples_at_generation')
    .limit(maxDrift * 5)

  const seen = new Set<string>(candidates.map((c) => c.venue_id))
  for (const t of (allTheses ?? []) as Array<{
    venue_id: string
    couples_at_generation: number
  }>) {
    if (seen.has(t.venue_id)) continue
    // Probe current cohort size by counting couple_identity_profile.
    const { count } = await supabase
      .from('couple_identity_profile')
      .select('wedding_id', { count: 'exact', head: true })
      .eq('venue_id', t.venue_id)
    const current = count ?? 0
    const baseline = t.couples_at_generation || 1
    if ((current - baseline) / baseline >= COHORT_GROWTH_THRESHOLD) {
      candidates.push({
        venue_id: t.venue_id,
        last_generated_at: '1970-01-01T00:00:00.000Z',
        couples_at_generation: t.couples_at_generation,
      })
      seen.add(t.venue_id)
    }
    if (candidates.length >= maxDrift * 3) break
  }

  // Cold-start path: venues with profiles but no thesis row at all.
  const { data: cold } = await supabase
    .from('couple_identity_profile')
    .select('venue_id')
    .limit(maxDrift * 5)
  for (const row of (cold ?? []) as Array<{ venue_id: string }>) {
    if (seen.has(row.venue_id)) continue
    const { data: existing } = await supabase
      .from('venue_thesis')
      .select('venue_id')
      .eq('venue_id', row.venue_id)
      .maybeSingle()
    if (!existing) {
      candidates.push({
        venue_id: row.venue_id,
        last_generated_at: '1970-01-01T00:00:00.000Z',
        couples_at_generation: 0,
      })
      seen.add(row.venue_id)
    }
    if (candidates.length >= maxDrift * 3) break
  }

  if (candidates.length === 0) return 0

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueVenueThesis({
      venueId: c.venue_id,
      triggerSignal: 'weekly_drift',
      supabase,
    })
    if (!r.skipped) enqueued += 1
  }
  return enqueued
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runVenueThesisSweep(
  options: RunVenueThesisSweepOptions = {},
): Promise<VenueThesisSweepResult> {
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
        '[venue-thesis-sweep] drift-refresh enqueue failed',
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
