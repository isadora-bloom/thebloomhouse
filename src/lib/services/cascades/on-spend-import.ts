/**
 * Marketing-spend import cascade.
 *
 * Fires when one or more marketing_spend rows land via ingest. The
 * downstream consumers (CAC computation, persona-channel rollups,
 * spend-flag detector) all run on cron + on-demand reads, so an
 * import doesn't strictly need to recompute everything synchronously.
 * What this cascade does:
 *
 *   1. Invalidate cached channel-intel-hub snapshots for the venue so
 *      the next read recomputes against fresh data.
 *   2. Run the spend-flag detector synchronously so any "this channel
 *      just went over budget" alerts surface immediately rather than
 *      on the next cron tick.
 *
 * Contract: fire-and-forget. Never throws.
 *
 * Best-effort. If the snapshot invalidation or flag detector aren't
 * wired for a venue (e.g. early-stage venue with no channel intel
 * snapshots), the cascade is a no-op.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface SpendImportCascadeArgs {
  venueId: string
  supabase: SupabaseClient
  /** Free-text — 'csv_upload' | 'manual_entry' | 'integration_sync'. */
  reason: string
  /** Period the imported spend covers — used to scope flag detection. */
  periodStart?: string | null
  periodEnd?: string | null
  correlationId?: string | null
}

export interface SpendImportCascadeResult {
  snapshotsInvalidated: number
  flagsDetected: number
  errors: string[]
  latencyMs: number
}

export async function triggerSpendImportCascade(
  args: SpendImportCascadeArgs,
): Promise<SpendImportCascadeResult> {
  const { venueId, supabase, reason, correlationId } = args
  const started = Date.now()
  const result: SpendImportCascadeResult = {
    snapshotsInvalidated: 0,
    flagsDetected: 0,
    errors: [],
    latencyMs: 0,
  }

  // Stage 1 — expire channel-intel snapshots so the next read recomputes.
  // channel_intel_snapshots.expires_at (mig 291) is the TTL column; we
  // back-date it to now so any future read sees expired.
  try {
    const { data, error } = await supabase
      .from('channel_intel_snapshots')
      .update({ expires_at: new Date().toISOString() })
      .eq('venue_id', venueId)
      .or(`expires_at.gt.${new Date().toISOString()},expires_at.is.null`)
      .select('id')
    if (error) {
      result.errors.push(`snapshot_invalidate: ${error.message}`)
    } else {
      result.snapshotsInvalidated = (data ?? []).length
    }
  } catch (err) {
    result.errors.push(
      `snapshot_invalidate: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Stage 2 — run the spend-flag detector. Dynamic import keeps the
  // cascade module light.
  try {
    const { detectMarketingFlags } = await import('../marketing-spend/loop/flag-detector')
    const out = await detectMarketingFlags({ venueId, supabase })
    result.flagsDetected = out.flagsCreated + out.flagsConfirmed
  } catch (err) {
    result.errors.push(
      `flag_detector: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  result.latencyMs = Date.now() - started

  logEvent({
    level: result.errors.length > 0 ? 'warn' : 'info',
    msg: 'cascade.spend_import',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'cascade.spend_import',
    outcome: result.errors.length > 0 ? 'fail' : 'ok',
    latency_ms: result.latencyMs,
    data: {
      reason,
      period_start: args.periodStart ?? null,
      period_end: args.periodEnd ?? null,
      snapshots_invalidated: result.snapshotsInvalidated,
      flags_detected: result.flagsDetected,
      error_count: result.errors.length,
      first_error: result.errors[0] ?? null,
    },
  })

  return result
}
