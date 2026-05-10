/**
 * Bloom House — Wave 7A discovery-engine-sweep service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7A pattern discovery engine)
 *   - bloom-wave4-5-6-master-plan.md (7A: weekly drift refresh — discovery
 *     is per-venue, low-volume, expensive Sonnet call so we pace at 3
 *     venues per tick)
 *   - feedback_parallel_stream_safety.md (cron registration deferred to
 *     reconciliation stream — Wave 7A does NOT touch vercel.json,
 *     /api/cron/route.ts, or /lib/cron-auth.ts. See TODO_CRON_REGISTRATION
 *     below.)
 *
 * What this service does
 * ----------------------
 *   1. Drains up to 3 oldest queued jobs from intel_discovery_jobs (atomic
 *      claim). Discovery is the most expensive tier of LLM job in the
 *      stack — three per tick is the safe cadence.
 *   2. Independently: drift-refresh enqueue. Picks venues whose most
 *      recent intel_discoveries row (or first-time venues with at least
 *      one couple_intel row) is older than 7 days and ENQUEUES them with
 *      trigger_signal='drift_refresh'. The 24h dedupe in the enqueue
 *      helper skips any with active jobs.
 *   3. Time-boxed at 280s (Vercel Pro 300s ceiling minus 20s buffer).
 *
 * Why 3 venues per tick (vs 5 elsewhere)
 * --------------------------------------
 * Each discovery run is a Sonnet call with ~3-5k input + ~1-3k output
 * tokens — comfortably the most expensive per-venue LLM job in the
 * stack. Three per tick means at the 1Hz cron schedule we still process
 * 3-9 venues per minute well within the Vercel function ceiling, and
 * even at 80 venues we recompute the cohort weekly within budget.
 *
 * Failure isolation
 * -----------------
 * Every job runs in its own try/catch. A single failure NEVER aborts
 * the sweep. Errors land on intel_discovery_jobs.error_text.
 *
 * TODO_CRON_REGISTRATION — register 'discovery_engine_sweep'
 * ----------------------------------------------------------
 * Cron registration must land in:
 *   1. src/app/api/cron/route.ts: add 'discovery_engine_sweep' to the
 *      job dispatcher; case 'discovery_engine_sweep' returns
 *      runDiscoverySweep().
 *   2. src/lib/cron-auth.ts: add 'discovery_engine_sweep' to
 *      DESTRUCTIVE_JOBS so the cron auth shape mirrors cohort_rollup_sweep
 *      / external_match_sweep / persona_channel_rollup_sweep.
 *   3. vercel.json: add a cron entry — weekly suggested
 *      ("0 8 * * 1" — Monday 8am UTC, well clear of daily/weekly Wave
 *      5/6 sweeps that already populate the cohort substrate).
 *
 * All three files are owned by the reconciliation stream during Wave
 * 7A's parallel run with Wave 5D + 6C. See feedback_parallel_stream_
 * safety.md for the rationale.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { runDiscoveryEngine } from './engine'
import { enqueueDiscoveryRun } from './enqueue'

const MAX_JOBS_PER_TICK = 3
const MAX_DRIFT_PER_TICK = 6
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

interface QueuedJob {
  id: string
  venue_id: string
  trigger_signal: string | null
}

export interface DiscoverySweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  drift_enqueued: number
  total_cost_cents: number
  total_inserted: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ jobId: string; venueId: string; error: string }>
}

export interface RunDiscoverySweepOptions {
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
  totalInserted: number
  failures: Array<{ jobId: string; venueId: string; error: string }>
  timeboxed: boolean
}> {
  const { data: jobsData } = await supabase
    .from('intel_discovery_jobs')
    .select('id, venue_id, trigger_signal')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(maxJobs)

  const jobs = (jobsData ?? []) as QueuedJob[]

  let processed = 0
  let done = 0
  let failed = 0
  let totalCostCents = 0
  let totalInserted = 0
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
      .from('intel_discovery_jobs')
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
      const result = await runDiscoveryEngine(
        { venueId: job.venue_id },
        { supabase },
      )
      totalCostCents += result.costCents
      totalInserted += result.inserted
      await supabase
        .from('intel_discovery_jobs')
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
          .from('intel_discovery_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error(
          '[discovery-engine-sweep] failed to mark job failed',
          { jobId: job.id, original: message, markErr },
        )
      }
    }
  }

  return {
    processed,
    done,
    failed,
    totalCostCents,
    totalInserted,
    failures,
    timeboxed,
  }
}

interface DriftCandidate {
  venue_id: string
  most_recent_at: string | null
}

async function enqueueDriftRefresh(
  supabase: SupabaseClient,
  maxDrift: number,
): Promise<number> {
  const cutoffMs = Date.now() - DRIFT_AGE_MS

  // Step 1: pull venues that ALREADY have at least one discovery row but
  // whose most recent created_at is older than 7 days. We over-fetch
  // and dedupe in JS (PostgREST doesn't expose DISTINCT ON cleanly).
  const { data: stale } = await supabase
    .from('intel_discoveries')
    .select('venue_id, created_at')
    .order('created_at', { ascending: false })
    .limit(2000)

  const mostRecentByVenue = new Map<string, string>()
  for (const row of (stale ?? []) as Array<{
    venue_id: string
    created_at: string
  }>) {
    if (!mostRecentByVenue.has(row.venue_id)) {
      mostRecentByVenue.set(row.venue_id, row.created_at)
    }
  }

  const candidates: DriftCandidate[] = []
  for (const [venueId, mostRecent] of mostRecentByVenue.entries()) {
    const t = Date.parse(mostRecent)
    if (Number.isFinite(t) && t < cutoffMs) {
      candidates.push({ venue_id: venueId, most_recent_at: mostRecent })
    }
  }

  // Step 2: cold-start path — venues that have couple_intel rows but no
  // discovery row at all. These should land in the queue on first tick.
  // (We only need to add NEW venue_ids — existing ones are already in
  // mostRecentByVenue.)
  const { data: cold } = await supabase
    .from('couple_intel')
    .select('venue_id')
    .limit(maxDrift * 5)

  const seen = new Set<string>(mostRecentByVenue.keys())
  for (const row of (cold ?? []) as Array<{ venue_id: string }>) {
    if (!row.venue_id || seen.has(row.venue_id)) continue
    seen.add(row.venue_id)
    candidates.push({ venue_id: row.venue_id, most_recent_at: null })
    if (candidates.length >= maxDrift * 3) break
  }

  if (candidates.length === 0) return 0

  // Sort: oldest first (cold-start venues first since most_recent_at=null
  // sorts to the top in a comparator that treats null as "very old").
  candidates.sort((a, b) => {
    const aT = a.most_recent_at ? Date.parse(a.most_recent_at) : 0
    const bT = b.most_recent_at ? Date.parse(b.most_recent_at) : 0
    return aT - bT
  })

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueDiscoveryRun({
      venueId: c.venue_id,
      triggerSignal: 'drift_refresh',
      supabase,
    })
    if (!r.skipped) enqueued += 1
  }

  return enqueued
}

/**
 * Walks the discovery queue + drift-refreshes per-venue runs every 7
 * days. Time-boxed at 280s. 3 venues per tick (discovery is expensive).
 */
export async function runDiscoverySweep(
  options: RunDiscoverySweepOptions = {},
): Promise<DiscoverySweepResult> {
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
        '[discovery-engine-sweep] drift-refresh enqueue failed',
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
      total_inserted: sweep.totalInserted,
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
      total_inserted: 0,
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
