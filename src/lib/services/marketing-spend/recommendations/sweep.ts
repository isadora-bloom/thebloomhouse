/**
 * Wave 6C — marketing recommendations sweep service.
 *
 * Anchor docs:
 *   - bloom-wave4-5-6-master-plan.md (6C: weekly recommendation job
 *     after Wave 6B's persona_channel_rollup_sweep — needs fresh
 *     rollups upstream)
 *   - feedback_parallel_stream_safety.md (cron registration deferred to
 *     reconciliation stream — see TODO below)
 *
 * What this service does
 * ----------------------
 * Drains the marketing_recommendation_jobs queue (atomic claim) plus
 * drift-refresh sweep across venues that have at least one
 * marketing_spend_records row in the trailing 90 days. Time-boxed at 3
 * venues per tick — recommendation generation makes a Sonnet call so
 * latency budget is tighter than the rollup sweep.
 *
 * Cron registration: NOT in this file. Cron registration must land in
 * src/app/api/cron/route.ts (job string 'marketing_recommendation_sweep')
 * and vercel.json — both files are owned by the reconciliation stream
 * during Wave 6C's parallel run with Waves 7A + 5D. See
 * feedback_parallel_stream_safety.md for why we don't touch them from
 * inside a parallel agent.
 *
 * TODO Wave 6C reconciliation: register the cron.
 *   1. Add 'marketing_recommendation_sweep' to VALID_JOBS in
 *      src/app/api/cron/route.ts
 *   2. Add a case 'marketing_recommendation_sweep':
 *        return runMarketingRecommendationSweep()
 *   3. Add a vercel.json cron entry — weekly suggested. MUST run after
 *      persona_channel_rollup_sweep (depends on fresh rollups).
 *      Suggested: Sunday 8:00am UTC (1 hour after 6B's sweep).
 *   4. Add to DESTRUCTIVE_JOBS in src/lib/cron-auth.ts (the
 *      recommendations table is service-role write only; sweep needs
 *      the same auth shape as persona_channel_rollup_sweep).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'
import { generateMarketingRecommendations } from './generate'

const MAX_VENUES_PER_TICK = 3
const TIMEBOX_MS = 280_000
const SPEND_LOOKBACK_DAYS = 90
const QUEUE_BATCH_SIZE = 5

export interface MarketingRecommendationSweepResult {
  ok: boolean
  venuesScanned: number
  venuesGenerated: number
  recommendationsInserted: number
  totalCostCents: number
  errors: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ venueId: string; error: string }>
}

export interface RunMarketingRecommendationSweepOptions {
  supabase?: SupabaseClient
  maxVenues?: number
  timeboxMs?: number
}

interface QueuedJobRow {
  id: string
  venue_id: string
  status: string
}

/**
 * Atomically claim one queued job. Returns null if no job was claimed.
 * Mirrors the identity_reconstruction_jobs pattern.
 */
async function claimQueuedJob(
  supabase: SupabaseClient,
): Promise<QueuedJobRow | null> {
  // Pick the oldest queued job.
  const { data: candidates } = await supabase
    .from('marketing_recommendation_jobs')
    .select('id, venue_id, status')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(QUEUE_BATCH_SIZE)
  for (const c of (candidates ?? []) as QueuedJobRow[]) {
    // Atomic claim: SET status='running' WHERE id=$1 AND status='queued'
    // RETURNING. PostgREST exposes the equivalent via update + filter.
    const { data: claimed, error } = await supabase
      .from('marketing_recommendation_jobs')
      .update({
        status: 'running',
        started_at: new Date().toISOString(),
      })
      .eq('id', c.id)
      .eq('status', 'queued')
      .select('id, venue_id, status')
      .maybeSingle()
    if (error) continue
    if (claimed) return claimed as QueuedJobRow
  }
  return null
}

async function markJobDone(
  supabase: SupabaseClient,
  jobId: string,
  recommendationsProduced: number,
  costCents: number,
): Promise<void> {
  await supabase
    .from('marketing_recommendation_jobs')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      recommendations_produced: recommendationsProduced,
      cost_cents: costCents,
    })
    .eq('id', jobId)
}

async function markJobFailed(
  supabase: SupabaseClient,
  jobId: string,
  errorText: string,
): Promise<void> {
  await supabase
    .from('marketing_recommendation_jobs')
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
  const cutoffMs = Date.now() - SPEND_LOOKBACK_DAYS * 86_400_000
  const cutoffDate = new Date(cutoffMs).toISOString().slice(0, 10)
  const { data, error } = await supabase
    .from('marketing_spend_records')
    .select('venue_id, spend_date')
    .gte('spend_date', cutoffDate)
    .order('spend_date', { ascending: false })
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
 * Drains queued jobs first, then drift-refreshes venues with recent
 * spend. Failure isolation: a single venue throw never aborts the
 * sweep. Time-boxed.
 */
export async function runMarketingRecommendationSweep(
  options: RunMarketingRecommendationSweepOptions = {},
): Promise<MarketingRecommendationSweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const maxVenues = options.maxVenues ?? MAX_VENUES_PER_TICK
  const timeboxMs = options.timeboxMs ?? TIMEBOX_MS
  const startedAt = Date.now()

  const result: MarketingRecommendationSweepResult = {
    ok: true,
    venuesScanned: 0,
    venuesGenerated: 0,
    recommendationsInserted: 0,
    totalCostCents: 0,
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
        const r = await generateMarketingRecommendations(claimed.venue_id, {
          supabase,
        })
        result.venuesGenerated += 1
        result.recommendationsInserted += r.inserted
        result.totalCostCents += r.costCents
        await markJobDone(supabase, claimed.id, r.inserted, r.costCents)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors += 1
        result.failures.push({ venueId: claimed.venue_id, error: message })
        await markJobFailed(supabase, claimed.id, message)
        logEvent({
          level: 'warn',
          msg: 'marketing_recommendation_sweep.queued_job_threw',
          event_type: 'cron.run',
          outcome: 'fail',
          venueId: claimed.venue_id,
          data: { jobId: claimed.id, error: message },
        })
      }
    }

    // 2. Drift refresh — venues with recent spend that we haven't yet
    //    processed in this tick.
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
          const r = await generateMarketingRecommendations(venueId, {
            supabase,
          })
          if (!r.shortCircuited) {
            result.venuesGenerated += 1
          }
          result.recommendationsInserted += r.inserted
          result.totalCostCents += r.costCents
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors += 1
          result.failures.push({ venueId, error: message })
          logEvent({
            level: 'warn',
            msg: 'marketing_recommendation_sweep.drift_refresh_threw',
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
    msg: 'marketing_recommendation_sweep.complete',
    event_type: 'cron.run',
    outcome: result.errors > 0 ? 'fail' : 'ok',
    data: {
      venuesScanned: result.venuesScanned,
      venuesGenerated: result.venuesGenerated,
      recommendationsInserted: result.recommendationsInserted,
      totalCostCents: result.totalCostCents,
      errors: result.errors,
      timeboxed: result.timeboxed,
      duration_ms: result.duration_ms,
    },
  })

  return result
}
