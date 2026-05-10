/**
 * Bloom House — Wave 5C external-match-sweep service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5C external-signal matching)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5C: per-couple AND per-cohort
 *     matching, ~$1/venue/day, 6h refresh cadence)
 *
 * TODO Wave 5C reconciliation: register 'external_match_sweep' job in
 * src/app/api/cron/route.ts dispatcher + add to DESTRUCTIVE_JOBS in
 * src/lib/cron-auth.ts (sequential reconciliation after Round 2 lands).
 * Schedule target: every 6 hours.
 *
 * Why this is a service (not embedded in a route)
 * -----------------------------------------------
 * vercel.json sits at the 40-cron Pro-plan ceiling, so this sweep
 * piggy-backs on the multi-job dispatcher at /api/cron?job=
 * external_match_sweep. Mirrors Wave 4 + 5A + 5B sweep patterns.
 *
 * Behaviour
 * ---------
 *   1. Pulls up to 5 oldest queued jobs from intel_match_jobs (venue
 *     volume is low — typically 1-3 scans per venue per day).
 *   2. For each job: atomic claim → findAndStoreExternalMatches →
 *     SET status='done' OR 'failed'.
 *   3. Independently: drift-refresh enqueue. Picks venues whose newest
 *     intel_matches.fired_at is older than 24h and ENQUEUES with
 *     trigger_signal='drift_refresh' (venue-level scope, weddingId=null).
 *     The 24h dedupe in the enqueue helper skips any with active jobs.
 *   4. Time-boxed at 280s (Vercel Pro 300s ceiling minus 20s buffer).
 *
 * Failure isolation
 * -----------------
 * Every job runs in its own try/catch. A single failure NEVER aborts
 * the sweep. Errors land on intel_match_jobs.error_text.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { findAndStoreExternalMatches } from './external-match'
import { enqueueExternalMatch } from './enqueue-external-match'

const MAX_JOBS_PER_TICK = 5
const MAX_DRIFT_PER_TICK = 10
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 24 * 60 * 60 * 1000 // 24h

interface QueuedJob {
  id: string
  venue_id: string
  wedding_id: string | null
  trigger_signal: string | null
}

interface DriftCandidate {
  venue_id: string
  newest_fired_at: string | null
}

export interface ExternalMatchSweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  drift_enqueued: number
  total_matches_stored: number
  total_cost_cents: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ jobId: string; venueId: string; error: string }>
}

export interface RunExternalMatchSweepOptions {
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
  totalMatches: number
  totalCostCents: number
  failures: Array<{ jobId: string; venueId: string; error: string }>
  timeboxed: boolean
}> {
  const { data: jobsData } = await supabase
    .from('intel_match_jobs')
    .select('id, venue_id, wedding_id, trigger_signal')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(maxJobs)

  const jobs = (jobsData ?? []) as QueuedJob[]

  let processed = 0
  let done = 0
  let failed = 0
  let totalMatches = 0
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
      .from('intel_match_jobs')
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
      const result = await findAndStoreExternalMatches(
        { venueId: job.venue_id, weddingId: job.wedding_id ?? null },
        { supabase },
      )
      totalMatches += result.stored
      totalCostCents += result.costCents
      await supabase
        .from('intel_match_jobs')
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
          .from('intel_match_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error(
          '[external-match-sweep] failed to mark job failed',
          { jobId: job.id, original: message, markErr },
        )
      }
    }
  }

  return {
    processed,
    done,
    failed,
    totalMatches,
    totalCostCents,
    failures,
    timeboxed,
  }
}

async function enqueueDriftRefresh(
  supabase: SupabaseClient,
  maxDrift: number,
): Promise<number> {
  // Find venues whose newest intel_matches row is older than 24h, OR
  // who have no intel_matches yet (cold start).
  const cutoff = new Date(Date.now() - DRIFT_AGE_MS).toISOString()

  // Cold-start path: pull venues with at least one couple_identity_profile
  // row.
  const { data: profileVenues } = await supabase
    .from('couple_identity_profile')
    .select('venue_id')
    .limit(maxDrift * 10)

  const candidateIds = new Set<string>()
  for (const r of (profileVenues ?? []) as { venue_id: string }[]) {
    if (r.venue_id) candidateIds.add(r.venue_id)
  }

  if (candidateIds.size === 0) return 0

  // For each candidate venue, check newest fired_at and decide.
  const candidates: DriftCandidate[] = []
  for (const venueId of candidateIds) {
    const { data } = await supabase
      .from('intel_matches')
      .select('fired_at')
      .eq('venue_id', venueId)
      .order('fired_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const newest = (data as { fired_at: string } | null)?.fired_at ?? null
    if (!newest || newest < cutoff) {
      candidates.push({ venue_id: venueId, newest_fired_at: newest })
    }
    if (candidates.length >= maxDrift * 3) break
  }

  if (candidates.length === 0) return 0

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueExternalMatch({
      venueId: c.venue_id,
      triggerSignal: 'drift_refresh',
      supabase,
    })
    if (!r.skipped) enqueued += 1
  }

  return enqueued
}

export async function runExternalMatchSweep(
  options: RunExternalMatchSweepOptions = {},
): Promise<ExternalMatchSweepResult> {
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
        '[external-match-sweep] drift-refresh enqueue failed',
        err instanceof Error ? err.message : err,
      )
    }

    return {
      ok: true,
      processed: sweep.processed,
      done: sweep.done,
      failed: sweep.failed,
      drift_enqueued: driftEnqueued,
      total_matches_stored: sweep.totalMatches,
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
      total_matches_stored: 0,
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
