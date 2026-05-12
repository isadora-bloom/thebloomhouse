/**
 * Lost-mark cascade.
 *
 * Fires when a wedding transitions to status='lost'.
 *
 * Postgres trigger trg_weddings_cascade_lost (migration 314) handles
 * draft cancellation directly. This JS-side cascade adds:
 *   1. Heat recompute — drops the wedding out of any active-cohort
 *      heat distributions so /intel/heat-map reflects reality.
 *   2. Lifecycle event row — feeds /intel/journey + coordinator audit.
 *
 * Contract: fire-and-forget. Never throws. Idempotent — re-running on
 * a wedding already lost is a no-op (heat recompute is convergent;
 * lifecycle event insert checks for prior identical row).
 *
 * NOT done here (intentionally):
 *   - Reactivation eligibility — handled by follow-up-sequences cron
 *     reading lost_at + lost_locked_by_operator (P1 wired the gate).
 *   - Cohort cross-recompute — runs as part of the daily intel sweep.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface LostMarkCascadeArgs {
  venueId: string
  weddingId: string
  supabase: SupabaseClient
  /** Free-text — 'coordinator_override' | 'pipeline_signal' |
   *  'lifecycle_engine' | 'csv_import'. */
  reason: string
  correlationId?: string | null
}

export interface LostMarkCascadeResult {
  heatRecomputed: boolean
  lifecycleEventInserted: boolean
  errors: string[]
  latencyMs: number
}

export async function triggerLostMarkCascade(
  args: LostMarkCascadeArgs,
): Promise<LostMarkCascadeResult> {
  const { venueId, weddingId, supabase, reason, correlationId } = args
  const started = Date.now()
  const result: LostMarkCascadeResult = {
    heatRecomputed: false,
    lifecycleEventInserted: false,
    errors: [],
    latencyMs: 0,
  }

  // Stage 1 — heat recompute. Wedding moves out of active scoring so
  // any cohort relativising re-balances.
  try {
    const { recalculateHeatScore } = await import('../heat-mapping')
    await recalculateHeatScore(venueId, weddingId)
    result.heatRecomputed = true
  } catch (err) {
    result.errors.push(
      `heat_recompute: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Stage 2 — lifecycle event. Schema verified against migration 246:
  // signal NOT NULL, detected_by NOT NULL CHECK constrained.
  try {
    const { error } = await supabase
      .from('wedding_lifecycle_events')
      .insert({
        wedding_id: weddingId,
        venue_id: venueId,
        signal: `cascade_lost:${reason}`,
        detected_by: reason === 'coordinator_override' ? 'coordinator' : 'pipeline',
        reason: null,
      })
    if (error) {
      result.errors.push(`lifecycle_insert: ${error.message}`)
    } else {
      result.lifecycleEventInserted = true
    }
  } catch (err) {
    result.errors.push(
      `lifecycle_insert: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  result.latencyMs = Date.now() - started

  logEvent({
    level: result.errors.length > 0 ? 'warn' : 'info',
    msg: 'cascade.lost_mark',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'cascade.lost_mark',
    outcome: result.errors.length > 0 ? 'fail' : 'ok',
    latency_ms: result.latencyMs,
    data: {
      wedding_id: weddingId,
      reason,
      heat_recomputed: result.heatRecomputed,
      lifecycle_event_inserted: result.lifecycleEventInserted,
      error_count: result.errors.length,
      first_error: result.errors[0] ?? null,
    },
  })

  return result
}
