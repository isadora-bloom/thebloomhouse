/**
 * Wave 7B — channel-role sweep service.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B)
 *
 * Drains attribution_role_jobs (signal-driven enqueues + drift refresh)
 * and classifies each event. Mirrors the identity-judge-sweep + couple-
 * intel-sweep shape so the cron dispatcher pattern is consistent.
 *
 * TODO (reconciliation stream): register this in /api/cron/route.ts as
 * job='attribution_role_sweep' + add a row to vercel.json + add
 * 'attribution_role_sweep' to DESTRUCTIVE_JOBS in src/lib/cron-auth.ts.
 * Wave 7B does NOT register the cron itself (avoids file-zone collision
 * with parallel agents on the cron route file). Daily cadence is the
 * target — the per-event drift window is 30 days so a daily tick keeps
 * pace easily.
 *
 * Behaviour
 * ---------
 *   1. Pulls up to 50 oldest queued jobs.
 *   2. Atomic claim per job (UPDATE WHERE status='queued').
 *   3. classifyAndPersistAttributionEvent → mark done | failed.
 *   4. Drift-refresh enqueue: pick up to 5 events whose
 *      role_classified_at is older than 30 days OR null and enqueue
 *      with trigger_signal='drift_refresh'.
 *   5. Time-boxed at 280s.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { classifyAndPersistAttributionEvent } from './classify'
import { enqueueRoleClassification } from './enqueue'

const MAX_JOBS_PER_TICK = 50
const MAX_DRIFT_PER_TICK = 5
const TIMEBOX_MS = 280_000
const DRIFT_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

interface QueuedJob {
  id: string
  attribution_event_id: string
  venue_id: string
  trigger_signal: string | null
}

interface DriftCandidate {
  id: string
  venue_id: string
  role_classified_at: string | null
}

export interface RoleSweepResult {
  ok: boolean
  processed: number
  done: number
  failed: number
  drift_enqueued: number
  total_cost_cents: number
  timeboxed: boolean
  duration_ms: number
  byRole: Record<string, number>
  failures: Array<{ jobId: string; attributionEventId: string; error: string }>
}

export interface RunRoleSweepOptions {
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
  byRole: Record<string, number>
  failures: Array<{ jobId: string; attributionEventId: string; error: string }>
  timeboxed: boolean
}> {
  const { data: jobsData } = await sb
    .from('attribution_role_jobs')
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
  const byRole: Record<string, number> = {}
  const failures: Array<{ jobId: string; attributionEventId: string; error: string }> = []

  for (const job of jobs) {
    if (Date.now() - startedAt >= timeboxMs) {
      timeboxed = true
      break
    }

    // Atomic claim — only proceed if still 'queued'.
    const { data: claimed, error: claimErr } = await sb
      .from('attribution_role_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('status', 'queued')
      .select('id')
      .maybeSingle()

    if (claimErr || !claimed) {
      // Another worker grabbed it (or it transitioned away).
      continue
    }

    processed += 1

    try {
      const out = await classifyAndPersistAttributionEvent(
        { attributionEventId: job.attribution_event_id },
        { supabase: sb },
      )
      totalCostCents += out.cost_cents
      byRole[out.role] = (byRole[out.role] ?? 0) + 1
      await sb
        .from('attribution_role_jobs')
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
          .from('attribution_role_jobs')
          .update({
            status: 'failed',
            completed_at: new Date().toISOString(),
            error_text: message.slice(0, 2000),
          })
          .eq('id', job.id)
      } catch (markErr) {
        console.error('[role-sweep] failed to mark job failed', {
          jobId: job.id,
          original: message,
          markErr,
        })
      }
    }
  }

  return { processed, done, failed, totalCostCents, byRole, failures, timeboxed }
}

async function enqueueDriftRefresh(sb: SupabaseClient, maxDrift: number): Promise<number> {
  const cutoff = new Date(Date.now() - DRIFT_AGE_MS).toISOString()

  // Over-fetch 3x so the dedupe filter inside enqueueRoleClassification
  // has room to skip already-active jobs without starving the budget.
  const { data: stale } = await sb
    .from('attribution_events')
    .select('id, venue_id, role_classified_at')
    .or(`role_classified_at.is.null,role_classified_at.lt.${cutoff}`)
    .is('reverted_at', null)
    .order('role_classified_at', { ascending: true, nullsFirst: true })
    .limit(maxDrift * 3)

  const candidates = (stale ?? []) as DriftCandidate[]
  if (candidates.length === 0) return 0

  let enqueued = 0
  for (const c of candidates) {
    if (enqueued >= maxDrift) break
    const r = await enqueueRoleClassification({
      attributionEventId: c.id,
      venueId: c.venue_id,
      triggerSignal: 'drift_refresh',
      supabase: sb,
    })
    if (!r.skipped) enqueued += 1
  }
  return enqueued
}

export async function runRoleSweep(
  options: RunRoleSweepOptions = {},
): Promise<RoleSweepResult> {
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
        '[role-sweep] drift-refresh enqueue failed',
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
      byRole: sweep.byRole,
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
      byRole: {},
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
