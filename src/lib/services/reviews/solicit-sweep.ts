/**
 * Bloom House — Wave 13 review-solicit sweep.
 *
 * Daily cron. Three passes:
 *   1. Drain queued review_solicit_jobs (batch up to 20).
 *   2. Backfill: find weddings whose event date is in [now-30d, now-7d]
 *      that have NEVER been solicited (no review_solicit_requests row).
 *      Enqueue them.
 *   3. Sweep no-response: flip 'sent' requests older than 60 days that
 *      never received a review to status='no_response'.
 *
 * Cron job name (TODO for cron route registration): review_solicit_sweep
 * Recommended cadence: daily at 12:00 UTC (after data integrity sweep
 * and the morning Sage briefs).
 *
 * Wave 13 does NOT register this cron in vercel.json or cron/route.ts —
 * the reconciliation stream handles cron-route wiring.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { solicitReview, enqueueReviewSolicit } from './solicit'

const PER_TICK_BUDGET = 20
const POST_EVENT_MIN_DAYS = 7
const POST_EVENT_MAX_DAYS = 30
const NO_RESPONSE_THRESHOLD_DAYS = 60

export interface ReviewSolicitSweepResult {
  processed: number
  drafted: number
  skipped: number
  backfilled: number
  no_response_flipped: number
  errors: string[]
}

interface JobRow {
  id: string
  wedding_id: string
  venue_id: string
}

async function claimJob(
  supabase: SupabaseClient,
  jobId: string,
): Promise<JobRow | null> {
  const { data, error } = await supabase
    .from('review_solicit_jobs')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', jobId)
    .eq('status', 'queued')
    .select('id, wedding_id, venue_id')
    .maybeSingle()
  if (error) return null
  return (data as JobRow | null) ?? null
}

async function finishJob(
  supabase: SupabaseClient,
  jobId: string,
  status: 'done' | 'failed' | 'skipped',
  requestId?: string | null,
  errorText?: string,
): Promise<void> {
  await supabase
    .from('review_solicit_jobs')
    .update({
      status,
      completed_at: new Date().toISOString(),
      request_id: requestId ?? null,
      error_text: errorText ?? null,
    })
    .eq('id', jobId)
}

export async function runReviewSolicitSweep(
  supabase?: SupabaseClient,
): Promise<ReviewSolicitSweepResult> {
  const sb = supabase ?? createServiceClient()
  const result: ReviewSolicitSweepResult = {
    processed: 0,
    drafted: 0,
    skipped: 0,
    backfilled: 0,
    no_response_flipped: 0,
    errors: [],
  }

  // ---- Pass 1: drain queued jobs ----
  const { data: queued } = await sb
    .from('review_solicit_jobs')
    .select('id, wedding_id, venue_id')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(PER_TICK_BUDGET)

  for (const job of (queued ?? []) as JobRow[]) {
    if (result.processed >= PER_TICK_BUDGET) break
    result.processed++
    const claimed = await claimJob(sb, job.id)
    if (!claimed) continue
    try {
      const r = await solicitReview({ weddingId: job.wedding_id, supabase: sb })
      if (r.ok) {
        result.drafted++
        await finishJob(sb, job.id, 'done', r.requestId)
      } else {
        result.skipped++
        await finishJob(sb, job.id, 'skipped', null, r.reason)
      }
    } catch (err) {
      result.errors.push(
        `job ${job.id} threw: ${err instanceof Error ? err.message : String(err)}`,
      )
      await finishJob(
        sb,
        job.id,
        'failed',
        null,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  // ---- Pass 2: backfill candidates ----
  // Find weddings with event date in [now-30d, now-7d] AND status booked
  // or completed AND no existing review_solicit_requests row. Enqueue
  // them. We bound at PER_TICK_BUDGET so a backlog drains across ticks.
  if (result.processed < PER_TICK_BUDGET) {
    const now = Date.now()
    const fromIso = new Date(now - POST_EVENT_MAX_DAYS * 86_400_000).toISOString().slice(0, 10)
    const toIso = new Date(now - POST_EVENT_MIN_DAYS * 86_400_000).toISOString().slice(0, 10)

    const { data: candidates } = await sb
      .from('weddings')
      .select('id, venue_id, wedding_date, status')
      .gte('wedding_date', fromIso)
      .lte('wedding_date', toIso)
      .in('status', ['booked', 'completed'])
      .limit(PER_TICK_BUDGET * 3)

    const wedRows =
      (candidates ?? []) as Array<{
        id: string
        venue_id: string
        wedding_date: string
        status: string | null
      }>
    if (wedRows.length > 0) {
      const ids = wedRows.map((w) => w.id)
      const { data: alreadyRequested } = await sb
        .from('review_solicit_requests')
        .select('wedding_id')
        .in('wedding_id', ids)
      const haveReq = new Set(
        ((alreadyRequested ?? []) as Array<{ wedding_id: string }>).map((r) => r.wedding_id),
      )
      for (const w of wedRows) {
        if (haveReq.has(w.id)) continue
        if (result.backfilled + result.processed >= PER_TICK_BUDGET) break
        const enq = await enqueueReviewSolicit({
          weddingId: w.id,
          venueId: w.venue_id,
          triggerSignal: 'sweep_post_event_backfill',
          supabase: sb,
        })
        if (!enq.skipped) {
          result.backfilled++
        }
      }
    }
  }

  // ---- Pass 3: flip stale 'sent' requests to 'no_response' ----
  const noRespCutoff = new Date(
    Date.now() - NO_RESPONSE_THRESHOLD_DAYS * 86_400_000,
  ).toISOString()
  const { data: stale } = await sb
    .from('review_solicit_requests')
    .select('id')
    .eq('status', 'sent')
    .lt('sent_at', noRespCutoff)
    .limit(100)
  for (const row of (stale ?? []) as Array<{ id: string }>) {
    const { error } = await sb
      .from('review_solicit_requests')
      .update({ status: 'no_response' })
      .eq('id', row.id)
      .eq('status', 'sent')
    if (!error) {
      result.no_response_flipped++
    }
  }

  return result
}
