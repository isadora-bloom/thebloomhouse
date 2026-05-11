/**
 * Wave 18 — Prediction recorder.
 *
 * Anchor docs (~/.claude memory/):
 *   - feedback_measure_dont_assume.md (a system that predicts must
 *     measure itself; this module is the substrate)
 *   - bloom-constitution.md (the forensic record's job is to be MORE
 *     COMPLETE than the couple's own memory; that includes our own
 *     prediction history)
 *
 * What this module does
 * ---------------------
 * Inserts one row into prediction_snapshots. Called fire-and-forget
 * from any prediction-producing surface — today only Wave 5A's
 * per-couple-derive.ts. Future producers (tour_likely judge,
 * re-engagement win-probability) wire here too without schema change.
 *
 * Idempotency
 * -----------
 * We dedupe re-records inside a 1-hour window for the same (wedding,
 * kind). The Wave 5A derive endpoint already has a 24h cache, so this
 * window mostly catches accidental double-fires (e.g. a coordinator
 * clicks "Re-derive" twice in a minute). Without this guard we'd
 * inflate the snapshot count on every UI re-click and skew the
 * Brier-score N.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const RECENT_DEDUPE_WINDOW_MS = 60 * 60 * 1000 // 1h

export type PredictionKind =
  | 'close_probability_pct'
  // Future kinds (no schema change required to add):
  // | 'persona_label'
  // | 'tour_likely'
  // | 'win_probability_proposal'

export interface RecordPredictionArgs {
  weddingId: string
  kind: PredictionKind
  /** The prediction itself. Stored as jsonb. For close_probability_pct
   *  pass the raw number 0-100; the recorder wraps it as { pct_0_100 }. */
  value: number | Record<string, unknown>
  /** Optional 0-100 confidence reported by the model itself. */
  confidence?: number | null
  /** Short identifier of the producer, e.g. 'wave_5a_couple_intel'. */
  source: string
  /** Prompt version constant from the producer. */
  promptVersion: string
  /** Cost of the call that produced this prediction (cents). */
  costCents?: number
  /** Optional venue id override; otherwise resolved from weddings table. */
  venueId?: string
  /** Optional supabase override (tests). */
  supabase?: SupabaseClient
}

export interface RecordPredictionResult {
  ok: boolean
  snapshotId?: string
  skipped?: boolean
  reason?: string
}

function wrapValue(
  kind: PredictionKind,
  value: number | Record<string, unknown>,
): Record<string, unknown> {
  if (kind === 'close_probability_pct') {
    if (typeof value === 'number') {
      return { pct_0_100: value }
    }
    // Caller passed an object — pass through but require pct_0_100 to
    // exist so analyze.ts can rely on it.
    if (typeof value === 'object' && value !== null && 'pct_0_100' in value) {
      return value
    }
    throw new Error(
      'recordPrediction: close_probability_pct value must be number or object with pct_0_100',
    )
  }
  if (typeof value === 'number') {
    return { value }
  }
  return value
}

export async function recordPrediction(
  args: RecordPredictionArgs,
): Promise<RecordPredictionResult> {
  const supabase = args.supabase ?? createServiceClient()

  // Resolve venue_id from the wedding when the caller didn't supply
  // one. We require it both as a defensive belt against orphaned rows
  // and because every dashboard query filters on venue_id.
  let venueId = args.venueId ?? null
  if (!venueId) {
    const { data: wedding, error } = await supabase
      .from('weddings')
      .select('venue_id, merged_into_id')
      .eq('id', args.weddingId)
      .maybeSingle()
    if (error || !wedding) {
      return { ok: false, reason: 'wedding lookup failed' }
    }
    const w = wedding as { venue_id: string; merged_into_id: string | null }
    if (w.merged_into_id) {
      // Tombstoned wedding — don't record predictions for merged
      // rows; the surviving wedding has its own snapshots.
      return { ok: true, skipped: true, reason: 'tombstoned' }
    }
    venueId = w.venue_id
  }

  // Dedupe within 1h of the same (wedding, kind).
  const sinceIso = new Date(Date.now() - RECENT_DEDUPE_WINDOW_MS).toISOString()
  const { data: recent } = await supabase
    .from('prediction_snapshots')
    .select('id, snapshotted_at')
    .eq('wedding_id', args.weddingId)
    .eq('prediction_kind', args.kind)
    .gte('snapshotted_at', sinceIso)
    .order('snapshotted_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (recent) {
    return {
      ok: true,
      skipped: true,
      reason: 'recent_duplicate',
      snapshotId: (recent as { id: string }).id,
    }
  }

  let predictedValue: Record<string, unknown>
  try {
    predictedValue = wrapValue(args.kind, args.value)
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  const { data: inserted, error: insertErr } = await supabase
    .from('prediction_snapshots')
    .insert({
      wedding_id: args.weddingId,
      venue_id: venueId,
      prediction_kind: args.kind,
      predicted_value: predictedValue,
      predicted_confidence_0_100:
        typeof args.confidence === 'number'
          ? Math.max(0, Math.min(100, Math.round(args.confidence)))
          : null,
      prediction_source: args.source,
      prompt_version: args.promptVersion,
      cost_cents: args.costCents ?? null,
    })
    .select('id')
    .single()

  if (insertErr || !inserted) {
    return {
      ok: false,
      reason: `insert failed: ${insertErr?.message ?? 'unknown'}`,
    }
  }

  return { ok: true, snapshotId: (inserted as { id: string }).id }
}
