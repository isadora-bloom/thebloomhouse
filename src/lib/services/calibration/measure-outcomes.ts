/**
 * Wave 18 — Outcome measurer.
 *
 * Anchor: feedback_measure_dont_assume.md
 *
 * What this module does
 * ---------------------
 * For weddings that have reached a terminal lifecycle state
 * (booked / lost / cancelled / post_event after event_date),
 * fill in the prediction_outcomes row for every prediction_snapshot
 * that doesn't yet have one. Idempotent — re-running on a wedding
 * with already-measured snapshots is a no-op (UNIQUE index on
 * prediction_snapshot_id).
 *
 * Per-kind semantics
 * ------------------
 * close_probability_pct:
 *   matched_prediction =
 *     (predicted >= 50 AND wedding booked)
 *     OR (predicted < 50 AND wedding lost/cancelled)
 *   error_magnitude    = | predicted - (100 if booked else 0) |
 *   actual_outcome     = {
 *     booked: boolean,
 *     lifecycle_stage: 'booked' | 'lost' | 'cancelled' | 'post_event',
 *     days_to_terminal: int  // snapshotted_at -> measured_at, days
 *   }
 *
 * Future kinds add their own match logic here.
 *
 * Wave 11 lifecycle is the canonical event source (we read
 * weddings.lifecycle_stage + lifecycle_stage_set_at, not the legacy
 * weddings.status enum). When lifecycle_stage is NULL (state machine
 * has not run yet) the wedding is not eligible for measurement —
 * we surface it as 'no_terminal_state'.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

// Terminal stages for measurement purposes. post_event is included
// because by the time we hit post_event the booking question is
// long-settled (booked happened upstream). cancelled and lost are
// the two "did not book" outcomes.
const TERMINAL_STAGES = new Set([
  'booked',
  'planning_active',
  'day_of',
  'post_event',
  'long_tail',
  'lost',
  'cancelled',
])

const BOOKED_STAGES = new Set([
  'booked',
  'planning_active',
  'day_of',
  'post_event',
  'long_tail',
])

const NOT_BOOKED_STAGES = new Set(['lost', 'cancelled'])

export interface MeasureOutcomesArgs {
  venueId?: string
  weddingId?: string
  supabase?: SupabaseClient
  /** Cap on how many snapshots to measure in one invocation. Default 500. */
  limit?: number
}

export interface MeasuredOutcome {
  snapshotId: string
  weddingId: string
  matched: boolean
  errorMagnitude: number
  predictedPct: number
  actualBooked: boolean
}

export interface MeasureOutcomesResult {
  ok: boolean
  measured: MeasuredOutcome[]
  skipped: number
  reason?: string
}

interface SnapshotRow {
  id: string
  wedding_id: string
  venue_id: string
  prediction_kind: string
  predicted_value: Record<string, unknown>
  snapshotted_at: string
}

interface WeddingRow {
  id: string
  lifecycle_stage: string | null
  lifecycle_stage_set_at: string | null
  booked_at: string | null
  status: string | null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function readPredictedPct(value: Record<string, unknown>): number | null {
  return asNumber(value.pct_0_100) ?? asNumber(value.value)
}

/**
 * Walk every prediction_snapshots row without a corresponding
 * prediction_outcomes row, look up the wedding's terminal state, and
 * write the outcome.
 *
 * Returns a summary plus the per-snapshot details (used by the sweep
 * for logging).
 */
export async function measureOutcomes(
  args: MeasureOutcomesArgs = {},
): Promise<MeasureOutcomesResult> {
  const supabase = args.supabase ?? createServiceClient()
  const limit = Math.max(1, Math.min(2000, args.limit ?? 500))

  // 1. Find snapshots without outcomes. Postgres LEFT JOIN pattern via
  //    the PostgREST "not exists" idiom is messy via the JS client,
  //    so we fetch candidate snapshots then filter client-side by
  //    looking up matched outcomes in batch.
  let query = supabase
    .from('prediction_snapshots')
    .select(
      'id, wedding_id, venue_id, prediction_kind, predicted_value, snapshotted_at',
    )
    .order('snapshotted_at', { ascending: true })
    .limit(limit * 2) // overshoot — many will already have outcomes

  if (args.venueId) query = query.eq('venue_id', args.venueId)
  if (args.weddingId) query = query.eq('wedding_id', args.weddingId)

  const { data: snapshots, error: snapErr } = await query
  if (snapErr) {
    return {
      ok: false,
      measured: [],
      skipped: 0,
      reason: `snapshot fetch failed: ${snapErr.message}`,
    }
  }
  if (!snapshots || snapshots.length === 0) {
    return { ok: true, measured: [], skipped: 0 }
  }

  const snapshotRows = snapshots as SnapshotRow[]
  const snapshotIds = snapshotRows.map((s) => s.id)

  // 2. Fetch existing outcomes for these snapshots.
  const { data: existing } = await supabase
    .from('prediction_outcomes')
    .select('prediction_snapshot_id')
    .in('prediction_snapshot_id', snapshotIds)
  const measuredSnapIds = new Set<string>(
    (existing ?? []).map(
      (r) => (r as { prediction_snapshot_id: string }).prediction_snapshot_id,
    ),
  )

  const candidates = snapshotRows
    .filter((s) => !measuredSnapIds.has(s.id))
    .slice(0, limit)
  if (candidates.length === 0) {
    return { ok: true, measured: [], skipped: 0 }
  }

  // 3. Load the weddings for terminal-state check.
  const weddingIds = Array.from(new Set(candidates.map((c) => c.wedding_id)))
  const { data: weddings, error: wErr } = await supabase
    .from('weddings')
    .select('id, lifecycle_stage, lifecycle_stage_set_at, booked_at, status')
    .in('id', weddingIds)
  if (wErr) {
    return {
      ok: false,
      measured: [],
      skipped: 0,
      reason: `wedding fetch failed: ${wErr.message}`,
    }
  }
  const weddingMap = new Map<string, WeddingRow>(
    (weddings ?? []).map((w) => [(w as WeddingRow).id, w as WeddingRow]),
  )

  // 4. For each candidate, compute the outcome if the wedding is in
  //    a terminal stage.
  const measured: MeasuredOutcome[] = []
  let skipped = 0
  const inserts: Array<{
    prediction_snapshot_id: string
    wedding_id: string
    venue_id: string
    actual_outcome: Record<string, unknown>
    matched_prediction: boolean
    error_magnitude: number
    measured_at: string
  }> = []

  for (const snap of candidates) {
    const wedding = weddingMap.get(snap.wedding_id)
    if (!wedding) {
      skipped++
      continue
    }
    const stage = wedding.lifecycle_stage
    if (!stage || !TERMINAL_STAGES.has(stage)) {
      // Wave 11 hasn't classified this wedding into a terminal state
      // yet. Skip — we'll measure on a later pass.
      skipped++
      continue
    }

    if (snap.prediction_kind !== 'close_probability_pct') {
      // Other kinds land here when they're added. For now skip so we
      // don't insert NULL outcomes for unsupported kinds.
      skipped++
      continue
    }

    const predicted = readPredictedPct(snap.predicted_value)
    if (predicted === null) {
      skipped++
      continue
    }

    const booked = BOOKED_STAGES.has(stage)
    const notBooked = NOT_BOOKED_STAGES.has(stage)
    if (!booked && !notBooked) {
      // Shouldn't happen — TERMINAL_STAGES is the union — but
      // defensive.
      skipped++
      continue
    }

    const matched =
      (predicted >= 50 && booked) || (predicted < 50 && notBooked)
    const errorMagnitude = Math.abs(predicted - (booked ? 100 : 0))

    const snapMs = Date.parse(snap.snapshotted_at)
    const stageSetMs = wedding.lifecycle_stage_set_at
      ? Date.parse(wedding.lifecycle_stage_set_at)
      : Date.now()
    const daysToTerminal = Number.isFinite(snapMs) && Number.isFinite(stageSetMs)
      ? Math.max(0, Math.round((stageSetMs - snapMs) / 86_400_000))
      : null

    inserts.push({
      prediction_snapshot_id: snap.id,
      wedding_id: snap.wedding_id,
      venue_id: snap.venue_id,
      actual_outcome: {
        booked,
        lifecycle_stage: stage,
        days_to_terminal: daysToTerminal,
      },
      matched_prediction: matched,
      error_magnitude: Number(errorMagnitude.toFixed(2)),
      measured_at: new Date().toISOString(),
    })

    measured.push({
      snapshotId: snap.id,
      weddingId: snap.wedding_id,
      matched,
      errorMagnitude,
      predictedPct: predicted,
      actualBooked: booked,
    })
  }

  // 5. Bulk insert. The UNIQUE index on prediction_snapshot_id makes
  //    a concurrent runner safe — second insert just errors at row
  //    level and we surface the count.
  if (inserts.length > 0) {
    const { error: insErr } = await supabase
      .from('prediction_outcomes')
      .insert(inserts)
    if (insErr) {
      // Most likely cause: a concurrent measurer raced us. Don't
      // return the rows we'd planned to write — measured here was
      // optimistic. Surface as a warning, not a hard fail.
      return {
        ok: false,
        measured: [],
        skipped: skipped + inserts.length,
        reason: `bulk insert failed: ${insErr.message}`,
      }
    }
  }

  return { ok: true, measured, skipped }
}

/**
 * Fire-and-forget enqueue of a measure-outcomes job for one wedding.
 *
 * IMPORTANT: This helper does NOT currently get called from Wave 11's
 * stage-triggers.ts because that file is shared territory (Waves 11
 * and 13 already wired it). The reconciliation stream wires the
 * call into stage-triggers.ts:
 *
 *   case 'booked': case 'lost': case 'cancelled': case 'post_event': {
 *     await enqueueMeasureOutcomes({ weddingId, venueId, ...,
 *       supabase, triggerSignal: `lifecycle_${toStage}` })
 *   }
 *
 * Until that wiring lands, the daily calibration_sweep cron picks up
 * dangling snapshots so the measurement still happens — just on a
 * 24h delay instead of instantly.
 */
export interface EnqueueMeasureOutcomesArgs {
  weddingId: string
  venueId: string
  triggerSignal?: string
  supabase?: SupabaseClient
}

export interface EnqueueMeasureOutcomesResult {
  ok: boolean
  jobId?: string
  skipped?: boolean
  reason?: string
}

export async function enqueueMeasureOutcomes(
  args: EnqueueMeasureOutcomesArgs,
): Promise<EnqueueMeasureOutcomesResult> {
  const supabase = args.supabase ?? createServiceClient()
  try {
    const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: existing } = await supabase
      .from('measure_outcome_jobs')
      .select('id, status, enqueued_at')
      .eq('wedding_id', args.weddingId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()
    if (existing) {
      return {
        ok: true,
        skipped: true,
        reason: 'dedupe_24h',
        jobId: (existing as { id: string }).id,
      }
    }
    const { data: inserted, error } = await supabase
      .from('measure_outcome_jobs')
      .insert({
        wedding_id: args.weddingId,
        venue_id: args.venueId,
        status: 'queued',
        trigger_signal: args.triggerSignal ?? null,
      })
      .select('id')
      .single()
    if (error || !inserted) {
      return {
        ok: false,
        reason: `insert failed: ${error?.message ?? 'unknown'}`,
      }
    }
    return { ok: true, jobId: (inserted as { id: string }).id }
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
