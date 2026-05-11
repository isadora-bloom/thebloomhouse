/**
 * Bloom House — Wave 14 referral-extraction sweep.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction)
 *   - bloom-wave4-identity-reconstruction.md (sibling-extractor pattern)
 *   - bloom-phase-b-decisions.md (attribution_events audit row pattern)
 *
 * Why this is a service (not embedded in a route)
 * -----------------------------------------------
 * vercel.json sits near the cron ceiling, so this sweep piggy-backs on
 * the multi-job dispatcher at /api/cron?job=referral_extraction_sweep
 * (TODO comment below — cron registration deferred per Wave 14 boundary;
 * reconciliation will add it).
 *
 * Behaviour
 * ---------
 *   1. Drains up to 10 oldest queued jobs per tick (referral extraction
 *      is cheaper than Wave 4/5A, but the resolver does N people
 *      lookups per mention — 10/tick keeps the worker latency safe).
 *   2. For each job: atomic claim → extractReferrers → resolveReferrer
 *      per mention → SET status='done' OR 'failed' (with result_summary).
 *   3. Independently: drift-refresh enqueue. Picks up to 3 weddings
 *      whose newest attribution_event with referrer_name_text is older
 *      than 30 days, OR who have a fresh couple_identity_profile but
 *      no Wave 14 attribution_event row yet, and enqueues them with
 *      trigger_signal='drift_refresh'.
 *   4. Time-boxed at 280s (Vercel Pro 300s ceiling minus 20s buffer).
 *
 * Failure isolation
 * -----------------
 * Every job runs in its own try/catch. A single failure NEVER aborts
 * the sweep. Errors land on referral_extraction_jobs.error_text.
 *
 * TODO: register cron entry in vercel.json + src/app/api/cron/route.ts
 * after Wave 11/14 land. Job string `referral_extraction_sweep`.
 * Recommended cadence: daily.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { extractReferrers } from './extract'
import { resolveReferrer } from './resolve'
import { enqueueReferralExtraction } from './enqueue'

const MAX_JOBS_PER_TICK = 10
const MAX_DRIFT_PER_TICK = 3
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

interface QueuedJob {
  id: string
  wedding_id: string
  venue_id: string
  trigger_signal: string | null
}

interface DriftCandidate {
  wedding_id: string
  venue_id: string
}

export interface ReferralSweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  drift_enqueued: number
  total_cost_cents: number
  total_mentions: number
  total_matched: number
  total_ambiguous: number
  total_deferred: number
  timeboxed: boolean
  duration_ms: number
  failures: Array<{ jobId: string; weddingId: string; error: string }>
}

export interface RunReferralSweepOptions {
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
  totalMentions: number
  totalMatched: number
  totalAmbiguous: number
  totalDeferred: number
  failures: Array<{ jobId: string; weddingId: string; error: string }>
  timeboxed: boolean
}> {
  const { data: jobsData } = await supabase
    .from('referral_extraction_jobs')
    .select('id, wedding_id, venue_id, trigger_signal')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(maxJobs)

  const jobs = (jobsData ?? []) as QueuedJob[]

  let processed = 0
  let done = 0
  let failed = 0
  let totalCostCents = 0
  let totalMentions = 0
  let totalMatched = 0
  let totalAmbiguous = 0
  let totalDeferred = 0
  let timeboxed = false
  const failures: Array<{ jobId: string; weddingId: string; error: string }> = []

  for (const job of jobs) {
    if (Date.now() - startedAt >= timeboxMs) {
      timeboxed = true
      break
    }

    // Atomic claim — only proceed if the row is still 'queued'.
    const { data: claimed, error: claimErr } = await supabase
      .from('referral_extraction_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle()

    if (claimErr || !claimed) continue
    processed += 1

    try {
      const result = await extractReferrers(
        { weddingId: job.wedding_id },
        { supabase },
      )
      totalCostCents += result.costCents
      totalMentions += result.output.referrer_mentions.length

      // Resolve each mention. Resolver writes its own attribution_event;
      // we tally outcomes for the summary.
      let mMatched = 0
      let mAmbiguous = 0
      let mDeferred = 0
      for (const mention of result.output.referrer_mentions) {
        const r = await resolveReferrer({
          newWeddingId: job.wedding_id,
          venueId: job.venue_id,
          mention,
          supabase,
        })
        if (r.kind === 'matched') mMatched += 1
        else if (r.kind === 'ambiguous') mAmbiguous += 1
        else if (r.kind === 'deferred') mDeferred += 1
      }
      totalMatched += mMatched
      totalAmbiguous += mAmbiguous
      totalDeferred += mDeferred

      await supabase
        .from('referral_extraction_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
          result_summary: {
            mentions_extracted: result.output.referrer_mentions.length,
            resolved: mMatched,
            ambiguous: mAmbiguous,
            deferred: mDeferred,
            refusals: result.output.refusals.length,
          },
        })
        .eq('id', job.id)
      done += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed += 1
      failures.push({ jobId: job.id, weddingId: job.wedding_id, error: message })
      try {
        await supabase
          .from('referral_extraction_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error(
          '[referral-sweep] failed to mark job failed',
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
    totalMentions,
    totalMatched,
    totalAmbiguous,
    totalDeferred,
    failures,
    timeboxed,
  }
}

/**
 * Drift refresh: enqueue extractions for weddings whose Wave 14 row is
 * stale (>30d) OR whose Wave 4 profile exists but has no Wave 14
 * attribution_event row at all.
 */
async function enqueueDriftRefresh(
  supabase: SupabaseClient,
  maxDrift: number,
): Promise<number> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_MS).toISOString()

  // Candidates: weddings with a Wave 4 profile but whose most-recent
  // referral-attribution event is older than 30 days OR doesn't exist.
  // Postgres can't easily express that in a single query without a
  // window function; we pick weddings with profiles, then in TS filter
  // out the ones with fresh referral events. Over-fetch 3x.
  const { data: profileRows } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id, venue_id, last_reconstructed_at')
    .order('last_reconstructed_at', { ascending: false })
    .limit(maxDrift * 10)

  const profiles = (profileRows ?? []) as Array<{
    wedding_id: string
    venue_id: string
    last_reconstructed_at: string
  }>
  if (profiles.length === 0) return 0

  const candidates: DriftCandidate[] = []
  for (const p of profiles) {
    const { data: lastEvent } = await supabase
      .from('attribution_events')
      .select('decided_at')
      .eq('wedding_id', p.wedding_id)
      .not('referrer_name_text', 'is', null)
      .is('reverted_at', null)
      .order('decided_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const lastDecidedAt = (lastEvent as { decided_at?: string } | null)?.decided_at ?? null
    if (lastDecidedAt === null || lastDecidedAt < cutoff) {
      candidates.push({ wedding_id: p.wedding_id, venue_id: p.venue_id })
    }
    if (candidates.length >= maxDrift * 3) break
  }

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueReferralExtraction({
      weddingId: c.wedding_id,
      venueId: c.venue_id,
      triggerSignal: 'drift_refresh',
      supabase,
    })
    if (!r.skipped) enqueued += 1
  }
  return enqueued
}

export async function runReferralSweep(
  options: RunReferralSweepOptions = {},
): Promise<ReferralSweepResult> {
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
        '[referral-sweep] drift-refresh enqueue failed',
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
      total_mentions: sweep.totalMentions,
      total_matched: sweep.totalMatched,
      total_ambiguous: sweep.totalAmbiguous,
      total_deferred: sweep.totalDeferred,
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
      total_mentions: 0,
      total_matched: 0,
      total_ambiguous: 0,
      total_deferred: 0,
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
