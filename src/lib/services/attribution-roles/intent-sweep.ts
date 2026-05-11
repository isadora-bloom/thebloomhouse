/**
 * Wave 16 — inquiry-intent classifier sweep service.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-may9-llm-vs-template.md
 *
 * Drains attribution_intent_jobs (signal-driven enqueues + drift
 * refresh) and classifies each event. Mirrors the Wave 7B
 * role-sweep shape so the cron dispatcher pattern is consistent.
 *
 * TODO (reconciliation stream): register this in /api/cron/route.ts
 * as job='intent_classify_sweep' + add a row to vercel.json + add
 * 'intent_classify_sweep' to DESTRUCTIVE_JOBS in src/lib/cron-auth.ts.
 * Wave 16 does NOT register the cron itself (avoids file-zone collision
 * with parallel agents on the cron route file). Daily cadence is the
 * target — the per-event drift window is 30 days so a daily tick keeps
 * pace easily.
 *
 * Behaviour
 * ---------
 *   1. Pulls up to 50 oldest queued jobs.
 *   2. Atomic claim per job (UPDATE WHERE status='queued').
 *   3. classifyAndPersistInquiryIntent → mark done | failed.
 *   4. Drift-refresh enqueue: pick up to 5 events whose
 *      intent_classified_at is older than 30 days OR null and
 *      enqueue with trigger_signal='drift_refresh'.
 *   5. Time-boxed at 280s.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { classifyAndPersistInquiryIntent } from './intent-classifier'
import { enqueueIntentClassification } from './intent-enqueue'

const MAX_JOBS_PER_TICK = 50
const MAX_DRIFT_PER_TICK = 5
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface QueuedJob {
  id: string
  attribution_event_id: string
  venue_id: string
  trigger_signal: string | null
}

interface DriftCandidate {
  id: string
  venue_id: string
  intent_classified_at: string | null
}

export interface IntentSweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  drift_enqueued: number
  total_cost_cents: number
  timeboxed: boolean
  duration_ms: number
  byIntent: Record<string, number>
  failures: Array<{ jobId: string; attributionEventId: string; error: string }>
}

export interface RunIntentSweepOptions {
  supabase?: SupabaseClient
  maxJobs?: number
  maxDrift?: number
  timeboxMs?: number
}

async function processQueuedJobs(
  sb: SupabaseClient,
  startedAt: number,
  maxJobs: number,
  timeboxMs: number,
): Promise<{
  processed: number
  done: number
  failed: number
  totalCostCents: number
  byIntent: Record<string, number>
  failures: Array<{ jobId: string; attributionEventId: string; error: string }>
  timeboxed: boolean
}> {
  const { data: jobsData } = await sb
    .from('attribution_intent_jobs')
    .select('id, attribution_event_id, venue_id, trigger_signal')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(maxJobs)

  const jobs = (jobsData ?? []) as QueuedJob[]

  let processed = 0
  let done = 0
  let failed = 0
  let totalCostCents = 0
  let timeboxed = false
  const byIntent: Record<string, number> = {}
  const failures: Array<{ jobId: string; attributionEventId: string; error: string }> = []

  for (const job of jobs) {
    if (Date.now() - startedAt >= timeboxMs) {
      timeboxed = true
      break
    }

    const { data: claimed, error: claimErr } = await sb
      .from('attribution_intent_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle()

    if (claimErr || !claimed) continue

    processed += 1

    try {
      const out = await classifyAndPersistInquiryIntent(
        { attributionEventId: job.attribution_event_id },
        { supabase: sb },
      )
      totalCostCents += out.cost_cents
      byIntent[out.intentClass] = (byIntent[out.intentClass] ?? 0) + 1
      await sb
        .from('attribution_intent_jobs')
        .update({ status: 'done', completed_at: new Date().toISOString() })
        .eq('id', job.id)
      done += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed += 1
      failures.push({
        jobId: job.id,
        attributionEventId: job.attribution_event_id,
        error: message,
      })
      try {
        await sb
          .from('attribution_intent_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error('[intent-sweep] failed to mark job failed', {
          jobId: job.id,
          original: message,
          markErr,
        })
      }
    }
  }

  return { processed, done, failed, totalCostCents, byIntent, failures, timeboxed }
}

async function enqueueDriftRefresh(sb: SupabaseClient, maxDrift: number): Promise<number> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_MS).toISOString()

  const { data: stale } = await sb
    .from('attribution_events')
    .select('id, venue_id, intent_classified_at')
    .or(`intent_classified_at.is.null,intent_classified_at.lt.${cutoff}`)
    .is('reverted_at', null)
    .order('intent_classified_at', { ascending: true, nullsFirst: true })
    .limit(maxDrift * 3)

  const candidates = (stale ?? []) as DriftCandidate[]
  if (candidates.length === 0) return 0

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueIntentClassification({
      attributionEventId: c.id,
      venueId: c.venue_id,
      triggerSignal: 'drift_refresh',
      supabase: sb,
    })
    if (!r.skipped) enqueued += 1
  }
  return enqueued
}

export async function runIntentSweep(
  options: RunIntentSweepOptions = {},
): Promise<IntentSweepResult> {
  const sb = options.supabase ?? createServiceClient()
  const maxJobs = options.maxJobs ?? MAX_JOBS_PER_TICK
  const maxDrift = options.maxDrift ?? MAX_DRIFT_PER_TICK
  const timeboxMs = options.timeboxMs ?? TIMEBOX_MS
  const startedAt = Date.now()

  try {
    const sweep = await processQueuedJobs(sb, startedAt, maxJobs, timeboxMs)

    let driftEnqueued = 0
    try {
      driftEnqueued = await enqueueDriftRefresh(sb, maxDrift)
    } catch (err) {
      console.warn(
        '[intent-sweep] drift-refresh enqueue failed',
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
      byIntent: sweep.byIntent,
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
      byIntent: {},
      failures: [
        {
          jobId: '__sweep__',
          attributionEventId: '__sweep__',
          error: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }
}
