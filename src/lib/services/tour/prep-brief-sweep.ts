/**
 * Bloom House — Wave 13 tour-prep-brief sweep.
 *
 * Daily cron. Two passes:
 *   1. Drain queued tour_prep_jobs (batch up to 20).
 *   2. Find tours scheduled in the next 24-48h without a brief yet and
 *      enqueue + process them.
 *
 * Cron job name (TODO for cron route registration): tour_prep_brief_sweep
 * Recommended cadence: daily at 09:00 UTC (after data integrity sweep
 * and before the daily-digest fires). Each brief is one Sonnet call,
 * ~$0.02; cap per tick at 20 (~$0.40).
 *
 * Wave 13 does NOT register this cron in vercel.json or cron/route.ts —
 * the reconciliation stream handles cron-route wiring. Wave 13's TODO
 * comment in cron/route.ts is the marker.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { generateTourPrepBrief } from './prep-brief'

const PER_TICK_BUDGET = 20
const HORIZON_HOURS = 48

export interface TourPrepBriefSweepResult {
  processed: number
  drafted: number
  skipped: number
  enqueued: number
  errors: string[]
}

interface CandidateTour {
  id: string
  venue_id: string
  wedding_id: string | null
  scheduled_at: string | null
}

interface JobRow {
  id: string
  tour_id: string
  venue_id: string
  wedding_id: string | null
}

/**
 * Atomic-claim a queued job. We use the same pattern as
 * identity_judge_sweep: update WHERE status='queued' AND id=$1 SET
 * status='running' RETURNING * — only one worker can claim a row.
 */
async function claimJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('tour_prep_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select('id, tour_id, venue_id, wedding_id')
    .maybeSingle()
  if (error) return null
  return (data as JobRow | null) ?? null
}

async function finishJob(
  supabase: SupabaseClient,
  jobId: string,
  status: 'done' | 'failed' | 'skipped',
  errorText?: string,
): Promise<void> {
  await supabase
    .from('tour_prep_jobs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      error_text: errorText ?? null,
    })
    .eq('id', jobId)
}

export async function runTourPrepBriefSweep(
  supabase?: SupabaseClient,
): Promise<TourPrepBriefSweepResult> {
  const sb = supabase ?? createServiceClient()
  const result: TourPrepBriefSweepResult = {
    processed: 0,
    drafted: 0,
    skipped: 0,
    enqueued: 0,
    errors: [],
  }

  // ---- Pass 1: drain queued jobs ----
  const { data: queued, error: qErr } = await sb
    .from('tour_prep_jobs')
    .select('id, tour_id, venue_id, wedding_id')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(PER_TICK_BUDGET)
  if (qErr) {
    result.errors.push('queue fetch failed: ' + qErr.message)
  }

  for (const job of (queued ?? []) as JobRow[]) {
    result.processed++
    const claimed = await claimJob(sb, job.id)
    if (!claimed) {
      // Another worker grabbed it.
      continue
    }
    try {
      const r = await generateTourPrepBrief({ tourId: job.tour_id, supabase: sb })
      if (r.ok) {
        result.drafted++
        await finishJob(sb, job.id, 'done')
      } else {
        result.skipped++
        await finishJob(sb, job.id, 'skipped', r.reason)
      }
    } catch (err) {
      result.errors.push(
        `job ${job.id} threw: ${err instanceof Error ? err.message : String(err)}`,
      )
      await finishJob(
        sb,
        job.id,
        'failed',
        err instanceof Error ? err.message : String(err),
      )
    }
    if (result.processed >= PER_TICK_BUDGET) break
  }

  // ---- Pass 2: find upcoming tours without a brief and enqueue ----
  if (result.processed < PER_TICK_BUDGET) {
    const nowIso = new Date().toISOString()
    const horizonIso = new Date(
      Date.now() + HORIZON_HOURS * 60 * 60 * 1000,
    ).toISOString()
    const { data: candidates, error: cErr } = await sb
      .from('tours')
      .select('id, venue_id, wedding_id, scheduled_at')
      .gte('scheduled_at', nowIso)
      .lte('scheduled_at', horizonIso)
      .order('scheduled_at', { ascending: true })
      .limit(PER_TICK_BUDGET * 2)
    if (cErr) {
      result.errors.push('candidate fetch failed: ' + cErr.message)
    }
    const tours = (candidates ?? []) as CandidateTour[]
    if (tours.length > 0) {
      const ids = tours.map((t) => t.id)
      const { data: existing } = await sb
        .from('tour_prep_briefs')
        .select('tour_id')
        .in('tour_id', ids)
      const have = new Set(
        ((existing ?? []) as Array<{ tour_id: string }>).map((r) => r.tour_id),
      )

      const { data: pendingJobs } = await sb
        .from('tour_prep_jobs')
        .select('tour_id')
        .in('tour_id', ids)
        .in('status', ['queued', 'running'])
      const pendingSet = new Set(
        ((pendingJobs ?? []) as Array<{ tour_id: string }>).map((r) => r.tour_id),
      )

      for (const t of tours) {
        if (have.has(t.id)) continue
        if (pendingSet.has(t.id)) continue
        if (result.enqueued + result.processed >= PER_TICK_BUDGET) break
        try {
          // We process inline here. Enqueueing + draining in two ticks
          // would slow first-fire by 24h on a daily cron. Per-tick budget
          // already caps work; if we hit budget we leave the rest as
          // unenqueued for the next tick to pick up.
          const r = await generateTourPrepBrief({
            tourId: t.id,
            supabase: sb,
          })
          if (r.ok) {
            result.drafted++
            result.enqueued++
          } else {
            result.skipped++
          }
        } catch (err) {
          result.errors.push(
            `tour ${t.id} threw: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
  }

  return result
}
