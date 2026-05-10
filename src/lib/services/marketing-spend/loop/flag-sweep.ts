/**
 * Wave 6D — flag detection sweep.
 *
 * Anchor docs:
 *   - bloom-wave4-5-6-master-plan.md (6D flag detector daily cycle)
 *   - feedback_parallel_stream_safety.md (cron registration deferred to
 *     reconciliation stream)
 *
 * What this service does
 * ----------------------
 * Drains the marketing_loop_jobs queue (kind=flag_detect) plus a drift
 * sweep across venues that have at least one persona_channel_rollup row
 * (the substrate the detector reads). Time-boxed at 5 venues per tick —
 * the detector is forensic-deterministic and cheap (no Sonnet call), so
 * we can fan out wider than the recommendation sweep.
 *
 * Cron registration: NOT in this file. Cron registration must land in
 * src/app/api/cron/route.ts (job string 'spend_loop_flag_sweep')
 * and vercel.json — both files are owned by the reconciliation stream
 * during Wave 6D's parallel run with Waves 7C + 8. See
 * feedback_parallel_stream_safety.md.
 *
 * TODO Wave 6D reconciliation: register the cron.
 *   1. Add 'spend_loop_flag_sweep' to VALID_JOBS in
 *      src/app/api/cron/route.ts
 *   2. Add a case 'spend_loop_flag_sweep':
 *        return runSpendLoopFlagSweep()
 *   3. Add a vercel.json cron entry — daily suggested. MUST run after
 *      persona_channel_rollup_sweep (depends on fresh rollups).
 *      Suggested: daily 7:30am UTC (30 mins after 6B's sweep).
 *   4. Add to DESTRUCTIVE_JOBS in src/lib/cron-auth.ts (the
 *      marketing_spend_flags table is service-role write only; sweep
 *      needs the same auth shape as persona_channel_rollup_sweep).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'
import { detectMarketingFlags } from './flag-detector'

const MAX_VENUES_PER_TICK = 5
const TIMEBOX_MS = 280_000
const ROLLUP_LOOKBACK_DAYS = 90
const QUEUE_BATCH_SIZE = 8

export interface SpendLoopFlagSweepResult {
  ok: boolean
  venuesScanned: number
  venuesDetected: number
  flagsCreated: number
  flagsConfirmed: number
  flagsResolved: number
  errors: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ venueId: string; error: string }>
}

export interface RunSpendLoopFlagSweepOptions {
  supabase?: SupabaseClient
  maxVenues?: number
  timeboxMs?: number
}

interface QueuedJobRow {
  id: string
  venue_id: string
  status: string
}

async function claimQueuedJob(
  supabase: SupabaseClient,
): Promise<QueuedJobRow | null> {
  const { data: candidates } = await supabase
    .from('marketing_loop_jobs')
    .select('id, venue_id, status')
    .eq('status', 'queued')
    .eq('job_kind', 'flag_detect')
    .order('enqueued_at', { ascending: true })
    .limit(QUEUE_BATCH_SIZE)
  for (const c of (candidates ?? []) as QueuedJobRow[]) {
    const { data: claimed } = await supabase
      .from('marketing_loop_jobs')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .eq('id', c.id)
      .eq('status', 'queued')
      .select('id, venue_id, status')
      .maybeSingle()
    if (claimed) return claimed as QueuedJobRow
  }
  return null
}

async function markJobDone(
  supabase: SupabaseClient,
  jobId: string,
  result: { flagsCreated: number; flagsConfirmed: number; flagsResolved: number },
): Promise<void> {
  await supabase
    .from('marketing_loop_jobs')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      results_jsonb: result,
    })
    .eq('id', jobId)
}

async function markJobFailed(
  supabase: SupabaseClient,
  jobId: string,
  errorText: string,
): Promise<void> {
  await supabase
    .from('marketing_loop_jobs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_text: errorText.slice(0, 2000),
    })
    .eq('id', jobId)
}

async function loadDriftRefreshVenueIds(
  supabase: SupabaseClient,
  exclude: Set<string>,
  remaining: number,
): Promise<string[]> {
  if (remaining <= 0) return []
  const cutoffMs = Date.now() - ROLLUP_LOOKBACK_DAYS * 86_400_000
  const cutoffIso = new Date(cutoffMs).toISOString()
  const { data, error } = await supabase
    .from('persona_channel_rollups')
    .select('venue_id, computed_at')
    .gte('computed_at', cutoffIso)
    .order('computed_at', { ascending: false })
    .limit(2000)
  if (error) return []
  const seen = new Set<string>()
  const venueIds: string[] = []
  for (const row of (data ?? []) as Array<{ venue_id: string }>) {
    if (!row.venue_id) continue
    if (exclude.has(row.venue_id) || seen.has(row.venue_id)) continue
    seen.add(row.venue_id)
    venueIds.push(row.venue_id)
    if (venueIds.length >= remaining) break
  }
  return venueIds
}

/**
 * Drains queued flag-detect jobs first, then drift-refreshes venues
 * with recent rollup activity. Failure isolation: a single venue throw
 * never aborts the sweep. Time-boxed.
 */
export async function runSpendLoopFlagSweep(
  options: RunSpendLoopFlagSweepOptions = {},
): Promise<SpendLoopFlagSweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const maxVenues = options.maxVenues ?? MAX_VENUES_PER_TICK
  const timeboxMs = options.timeboxMs ?? TIMEBOX_MS
  const startedAt = Date.now()

  const result: SpendLoopFlagSweepResult = {
    ok: true,
    venuesScanned: 0,
    venuesDetected: 0,
    flagsCreated: 0,
    flagsConfirmed: 0,
    flagsResolved: 0,
    errors: 0,
    timeboxed: false,
    duration_ms: 0,
    failures: [],
  }

  const processedVenueIds = new Set<string>()

  try {
    // 1. Drain queued jobs first.
    while (result.venuesScanned < maxVenues) {
      if (Date.now() - startedAt >= timeboxMs) {
        result.timeboxed = true
        break
      }
      const claimed = await claimQueuedJob(supabase)
      if (!claimed) break
      processedVenueIds.add(claimed.venue_id)
      result.venuesScanned += 1
      try {
        const r = await detectMarketingFlags({
          venueId: claimed.venue_id,
          supabase,
        })
        result.venuesDetected += 1
        result.flagsCreated += r.flagsCreated
        result.flagsConfirmed += r.flagsConfirmed
        result.flagsResolved += r.flagsResolved
        await markJobDone(supabase, claimed.id, {
          flagsCreated: r.flagsCreated,
          flagsConfirmed: r.flagsConfirmed,
          flagsResolved: r.flagsResolved,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors += 1
        result.failures.push({ venueId: claimed.venue_id, error: message })
        await markJobFailed(supabase, claimed.id, message)
        logEvent({
          level: 'warn',
          msg: 'spend_loop_flag_sweep.queued_job_threw',
          event_type: 'cron.run',
          outcome: 'fail',
          venueId: claimed.venue_id,
          data: { jobId: claimed.id, error: message },
        })
      }
    }

    // 2. Drift refresh — venues with recent rollup activity that we
    //    haven't yet processed in this tick.
    if (
      result.venuesScanned < maxVenues &&
      Date.now() - startedAt < timeboxMs
    ) {
      const remaining = maxVenues - result.venuesScanned
      const driftIds = await loadDriftRefreshVenueIds(
        supabase,
        processedVenueIds,
        remaining,
      )
      for (const venueId of driftIds) {
        if (Date.now() - startedAt >= timeboxMs) {
          result.timeboxed = true
          break
        }
        result.venuesScanned += 1
        try {
          const r = await detectMarketingFlags({ venueId, supabase })
          result.venuesDetected += 1
          result.flagsCreated += r.flagsCreated
          result.flagsConfirmed += r.flagsConfirmed
          result.flagsResolved += r.flagsResolved
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors += 1
          result.failures.push({ venueId, error: message })
          logEvent({
            level: 'warn',
            msg: 'spend_loop_flag_sweep.drift_refresh_threw',
            event_type: 'cron.run',
            outcome: 'fail',
            venueId,
            data: { error: message },
          })
        }
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    result.errors += 1
    result.ok = false
    result.failures.push({ venueId: '__sweep__', error: message })
  }

  result.duration_ms = Date.now() - startedAt

  logEvent({
    level: 'info',
    msg: 'spend_loop_flag_sweep.complete',
    event_type: 'cron.run',
    outcome: result.errors > 0 ? 'fail' : 'ok',
    data: {
      venuesScanned: result.venuesScanned,
      venuesDetected: result.venuesDetected,
      flagsCreated: result.flagsCreated,
      flagsConfirmed: result.flagsConfirmed,
      flagsResolved: result.flagsResolved,
      errors: result.errors,
      timeboxed: result.timeboxed,
      duration_ms: result.duration_ms,
    },
  })

  return result
}
