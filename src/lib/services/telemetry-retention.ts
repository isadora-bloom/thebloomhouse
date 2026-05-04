/**
 * Telemetry retention sweeper (#96 / Pattern-I regression — Stream PPP).
 *
 * Six telemetry tables had no retention policy and were growing unbounded:
 *
 *   - api_costs           90d   cost telemetry; superseded after the billing cycle
 *   - cron_runs           30d   operational telemetry; the dashboard only
 *                               needs the rolling-30d window for trend lines
 *   - metered_events      90d   counter / histogram store
 *   - lead_score_history  365d  drives heat-trajectory bucketing on AA;
 *                               keep a year so YoY comparisons survive
 *
 * Two telemetry-shaped tables are deliberately EXCLUDED from this sweeper:
 *
 *   - interactions    forensic record + legal/audit (coordinators may need
 *                     full history of inbound/outbound emails for a couple
 *                     who disputes a charge or asks for their data export).
 *   - phrase_usage    training signal that the voice-DNA refresh consumes;
 *                     deleting old rows would degrade the voice anchors.
 *
 * Coordinator-data tables (weddings, voice_preferences, marketing_spend,
 * pricing_history, cultural_moments, etc.) are NEVER touched here.
 *
 * Sequencing: registered as a 02:00 UTC cron — runs BEFORE the 03:00+ morning
 * crons fire so the pre-burst telemetry window is already trimmed when
 * dashboards reload.
 *
 * Idempotent — re-running deletes only the rows that aged in since the prior
 * tick. Each per-table prune runs independently; failures on one table do
 * not block the others (errors[] surfaces them in the cron telemetry).
 */

import { createServiceClient } from '@/lib/supabase/service'

/** Per-table TTL in days. Centralised so the audit page + ops doc can
 *  read the same constants and any future change is a one-line edit. */
export const TELEMETRY_TTLS = {
  api_costs: 90,
  cron_runs: 30,
  metered_events: 90,
  lead_score_history: 365,
} as const

export interface TelemetryRetentionResult {
  api_costs_deleted: number
  cron_runs_deleted: number
  metered_events_deleted: number
  lead_score_history_deleted: number
  errors: string[]
}

/**
 * Run the nightly telemetry-retention prune. Service-role client; safe to
 * invoke from the cron route. Returns per-table delete counts plus a
 * collected errors[] array.
 */
export async function runTelemetryRetentionPrune(): Promise<TelemetryRetentionResult> {
  const supabase = createServiceClient()
  const now = Date.now()
  const errors: string[] = []

  const ttl = (days: number) => new Date(now - days * 24 * 60 * 60 * 1000).toISOString()
  const apiCostsCutoff = ttl(TELEMETRY_TTLS.api_costs)
  const cronRunsCutoff = ttl(TELEMETRY_TTLS.cron_runs)
  const meteredEventsCutoff = ttl(TELEMETRY_TTLS.metered_events)
  const leadScoreHistoryCutoff = ttl(TELEMETRY_TTLS.lead_score_history)

  // api_costs — created_at predates the row.
  let apiCostsDeleted = 0
  try {
    const { data, error } = await supabase
      .from('api_costs')
      .delete()
      .lt('created_at', apiCostsCutoff)
      .select('id')
    if (error) errors.push(`api_costs: ${error.message}`)
    apiCostsDeleted = (data ?? []).length
  } catch (err) {
    errors.push(`api_costs: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  // cron_runs — started_at is the canonical timestamp (every row has one).
  let cronRunsDeleted = 0
  try {
    const { data, error } = await supabase
      .from('cron_runs')
      .delete()
      .lt('started_at', cronRunsCutoff)
      .select('id')
    if (error) errors.push(`cron_runs: ${error.message}`)
    cronRunsDeleted = (data ?? []).length
  } catch (err) {
    errors.push(`cron_runs: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  // metered_events — observed_at on the counter row (per migration 151).
  let meteredEventsDeleted = 0
  try {
    const { data, error } = await supabase
      .from('metered_events')
      .delete()
      .lt('observed_at', meteredEventsCutoff)
      .select('id')
    if (error) errors.push(`metered_events: ${error.message}`)
    meteredEventsDeleted = (data ?? []).length
  } catch (err) {
    errors.push(`metered_events: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  // lead_score_history — calculated_at when the heat-mapping service stamped it
  // (per migration 002 schema).
  let leadScoreHistoryDeleted = 0
  try {
    const { data, error } = await supabase
      .from('lead_score_history')
      .delete()
      .lt('calculated_at', leadScoreHistoryCutoff)
      .select('id')
    if (error) errors.push(`lead_score_history: ${error.message}`)
    leadScoreHistoryDeleted = (data ?? []).length
  } catch (err) {
    errors.push(`lead_score_history: ${err instanceof Error ? err.message : 'unknown'}`)
  }

  console.log(
    `[telemetry_retention] api_costs=${apiCostsDeleted} cron_runs=${cronRunsDeleted} ` +
    `metered_events=${meteredEventsDeleted} lead_score_history=${leadScoreHistoryDeleted}` +
    (errors.length > 0 ? ` errors=${errors.length}` : ''),
  )

  return {
    api_costs_deleted: apiCostsDeleted,
    cron_runs_deleted: cronRunsDeleted,
    metered_events_deleted: meteredEventsDeleted,
    lead_score_history_deleted: leadScoreHistoryDeleted,
    errors,
  }
}
