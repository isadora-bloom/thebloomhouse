/**
 * POST /api/agent/cost-ceiling/replay (T5-eta.2 / Stream M)
 *
 * Coordinator-triggered backfill of work skipped during a cost-ceiling
 * pause. The /pulse banner + the paused_period_recap notification both
 * link here.
 *
 * Behavior:
 *   - Read pending paused_period_skipped rows for this coordinator's
 *     venue.
 *   - Mark them as 'replayed' BEFORE firing the actual work — that
 *     way a slow/aborted work step doesn't double-fire on a retry.
 *   - Re-execute each unique work_type once for the venue (Vercel
 *     Function execution-time-friendly: at most 6 work types in
 *     practice, idempotent at the work side).
 *
 * Failure mode: if a work_type's runner fails, log + continue. The
 * row is already marked replayed so a partial failure doesn't loop.
 *
 * Auth: getPlatformAuth — coordinator must be signed in to a venue.
 */

import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

interface ReplayResult {
  venueId: string
  workTypes: string[]
  replayedRows: number
  outcomes: Array<{ workType: string; ok: boolean; error?: string }>
}

async function executeWorkType(workType: string, venueId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    switch (workType) {
      case 'weekly_digest': {
        const { generateWeeklyDigest } = await import('@/lib/services/weekly-digest')
        await generateWeeklyDigest(venueId)
        return { ok: true }
      }
      case 'weekly_briefing': {
        const { generateWeeklyBriefing } = await import('@/lib/services/briefings')
        await generateWeeklyBriefing(venueId)
        return { ok: true }
      }
      case 'monthly_briefing': {
        const { generateMonthlyBriefing } = await import('@/lib/services/briefings')
        await generateMonthlyBriefing(venueId)
        return { ok: true }
      }
      case 'anomaly_detection': {
        const { runAnomalyDetection } = await import('@/lib/services/anomaly-detection')
        await runAnomalyDetection(venueId)
        return { ok: true }
      }
      case 'follow_up_sequences': {
        const { generateFollowUps } = await import('@/lib/services/follow-up-sequences')
        await generateFollowUps(venueId)
        return { ok: true }
      }
      case 'intelligence_analysis': {
        const { runIntelligenceAnalysis } = await import('@/lib/services/intelligence-engine')
        await runIntelligenceAnalysis(venueId)
        return { ok: true }
      }
      case 'daily_digest': {
        const { sendDigestEmail } = await import('@/lib/services/daily-digest')
        await sendDigestEmail(venueId)
        return { ok: true }
      }
      case 'correlation_analysis': {
        // Correlation engine works across all venues; for a single-
        // venue replay we re-run the per-venue computation directly.
        const { computeCorrelationsForVenue } = await import('@/lib/services/correlation-engine')
        const supabase = createServiceClient()
        await computeCorrelationsForVenue({ supabase, venueId })
        return { ok: true }
      }
      default:
        return { ok: false, error: `unknown work_type: ${workType}` }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' }
  }
}

export async function POST(): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (!auth.venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const supabase = createServiceClient()
  const venueId = auth.venueId

  // Pull pending rows.
  const { data: rows, error } = await supabase
    .from('paused_period_skipped')
    .select('id, work_type')
    .eq('venue_id', venueId)
    .eq('status', 'pending')
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const pending = (rows ?? []) as Array<{ id: string; work_type: string }>
  if (pending.length === 0) {
    return NextResponse.json({ ok: true, replayed: 0, message: 'no pending work to replay' })
  }

  const ids = pending.map((r) => r.id)
  const uniqueTypes = Array.from(new Set(pending.map((r) => r.work_type)))

  // Mark as replayed BEFORE firing work — avoids double-fire on
  // user retry / Vercel function timeout.
  await supabase
    .from('paused_period_skipped')
    .update({ status: 'replayed', replayed_at: new Date().toISOString() })
    .in('id', ids)

  const outcomes: ReplayResult['outcomes'] = []
  for (const workType of uniqueTypes) {
    if (workType === 'unknown') {
      outcomes.push({ workType, ok: false, error: 'unknown work_type recorded; cannot replay' })
      continue
    }
    const r = await executeWorkType(workType, venueId)
    outcomes.push({ workType, ok: r.ok, error: r.error })
  }

  // Stamp outcomes back onto the rows so the audit trail survives.
  await supabase
    .from('paused_period_skipped')
    .update({ replay_result: { outcomes } })
    .in('id', ids)

  const result: ReplayResult = {
    venueId,
    workTypes: uniqueTypes,
    replayedRows: ids.length,
    outcomes,
  }

  return NextResponse.json({ ok: true, ...result })
}
