/**
 * Wave 6D — weekly digest sweep.
 *
 * Anchor docs:
 *   - bloom-wave4-5-6-master-plan.md (6D weekly digest cycle)
 *   - feedback_parallel_stream_safety.md (cron registration deferred to
 *     reconciliation stream)
 *
 * What this service does
 * ----------------------
 * Drains the marketing_loop_jobs queue (kind=digest_build) plus a drift
 * sweep across venues that have at least one persona_channel_rollup row
 * (substrate signal). Time-boxed at 3 venues per tick — the digest
 * builder makes a Sonnet call per venue (~$0.05) and we want headroom
 * for slow LLM responses.
 *
 * Cron registration: NOT in this file. Cron registration must land in
 * src/app/api/cron/route.ts (job string 'marketing_digest_sweep') and
 * vercel.json — both files are owned by the reconciliation stream
 * during Wave 6D's parallel run with Waves 7C + 8.
 *
 * TODO Wave 6D reconciliation: register the cron.
 *   1. Add 'marketing_digest_sweep' to VALID_JOBS in
 *      src/app/api/cron/route.ts
 *   2. Add a case 'marketing_digest_sweep':
 *        return runMarketingDigestSweep()
 *   3. Add a vercel.json cron entry — weekly Mondays. MUST run after
 *      spend_loop_flag_sweep + marketing_recommendation_sweep (depends
 *      on fresh flags + recs to narrate). Suggested: Monday 9:30am UTC
 *      (well after Sunday's flag sweep + the rec sweep have run).
 *   4. Add to DESTRUCTIVE_JOBS in src/lib/cron-auth.ts (the
 *      marketing_digests table is service-role write only; sweep needs
 *      the same auth shape as marketing_recommendation_sweep).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { logEvent } from '@/lib/observability/logger'
import { buildWeeklyDigest } from './digest-builder'

const MAX_VENUES_PER_TICK = 3
const TIMEBOX_MS = 280_000
const ROLLUP_LOOKBACK_DAYS = 90
const QUEUE_BATCH_SIZE = 5

export interface MarketingDigestSweepResult {
  ok: boolean
  venuesScanned: number
  venuesGenerated: number
  digestsWritten: number
  totalCostCents: number
  errors: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ venueId: string; error: string }>
}

export interface RunMarketingDigestSweepOptions {
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
    .eq('job_kind', 'digest_build')
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
  result: { digestsWritten: number; costCents: number },
): Promise<void> {
  await supabase
    .from('marketing_loop_jobs')
    .update({
      status: 'done',
      completed_at: new Date().toISOString(),
      results_jsonb: { digestsWritten: result.digestsWritten },
      cost_cents: result.costCents,
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

export async function runMarketingDigestSweep(
  options: RunMarketingDigestSweepOptions = {},
): Promise<MarketingDigestSweepResult> {
  const supabase = options.supabase ?? createServiceClient()
  const maxVenues = options.maxVenues ?? MAX_VENUES_PER_TICK
  const timeboxMs = options.timeboxMs ?? TIMEBOX_MS
  const startedAt = Date.now()

  const result: MarketingDigestSweepResult = {
    ok: true,
    venuesScanned: 0,
    venuesGenerated: 0,
    digestsWritten: 0,
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
        const r = await buildWeeklyDigest(claimed.venue_id, { supabase })
        result.venuesGenerated += 1
        result.digestsWritten += 1
        result.totalCostCents += r.costCents
        await markJobDone(supabase, claimed.id, {
          digestsWritten: 1,
          costCents: r.costCents,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors += 1
        result.failures.push({ venueId: claimed.venue_id, error: message })
        await markJobFailed(supabase, claimed.id, message)
        logEvent({
          level: 'warn',
          msg: 'marketing_digest_sweep.queued_job_threw',
          event_type: 'cron.run',
          outcome: 'fail',
          venueId: claimed.venue_id,
          data: { jobId: claimed.id, error: message },
        })
      }
    }

    // 2. Drift refresh.
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
          const r = await buildWeeklyDigest(venueId, { supabase })
          result.venuesGenerated += 1
          result.digestsWritten += 1
          result.totalCostCents += r.costCents
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          result.errors += 1
          result.failures.push({ venueId, error: message })
          logEvent({
            level: 'warn',
            msg: 'marketing_digest_sweep.drift_refresh_threw',
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
    msg: 'marketing_digest_sweep.complete',
    event_type: 'cron.run',
    outcome: result.errors > 0 ? 'fail' : 'ok',
    data: {
      venuesScanned: result.venuesScanned,
      venuesGenerated: result.venuesGenerated,
      digestsWritten: result.digestsWritten,
      totalCostCents: result.totalCostCents,
      errors: result.errors,
      timeboxed: result.timeboxed,
      duration_ms: result.duration_ms,
    },
  })

  return result
}
