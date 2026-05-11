/**
 * Wave 9 — integrity remediation sweep.
 *
 * Anchor docs:
 *   - bloom-data-integrity-sweep.md (the data_integrity_sweep cron
 *     writes anomaly_alerts daily — this remediation sweep runs in
 *     parallel and writes integrity_remediations rows; the two are
 *     independent)
 *   - feedback_parallel_stream_safety.md (don't touch shared cron
 *     files — `/api/cron/route.ts`, `vercel.json`, `cron-auth.ts`.
 *     This file declares the job string + handler; the reconciliation
 *     stream wires it.)
 *
 * Behaviour
 * ---------
 *
 * For each venue:
 *   - Default to mode='dry_run' (detect + preview only). Cron does NOT
 *     apply by default — operator action required.
 *   - If venue_config.feature_flags.integrity_auto_remediate=true (per
 *     venue opt-in), use mode='apply'.
 *
 * Per-tick budget: 3 venues, time-boxed 280s. Mirrors other heavy
 * sweeps (data_integrity_sweep itself, identity_judge_sweep). Cheap
 * enough that the per-tick limit usually isn't reached, but the
 * time-box prevents stalls on a slow venue blocking all others.
 *
 * TODO: register as `integrity_remediation_sweep` job in
 * src/app/api/cron/route.ts + add cron entry in vercel.json. Do NOT
 * register from this file — the reconciliation stream is the owner of
 * shared cron files (per feedback_parallel_stream_safety.md).
 */

import { createServiceClient } from '@/lib/supabase/service'
import { runAllRemediations, persistRemediationRun, SUPPORTED_INVARIANT_IDS } from './index'
import type { RemediationMode, RemediationResult } from './types'

const PER_TICK_VENUE_LIMIT = 3
const TIME_BUDGET_MS = 280_000

interface VenueRow {
  id: string
  name: string | null
}

interface VenueConfigRow {
  venue_id: string
  feature_flags: { integrity_auto_remediate?: boolean } | null
}

export interface SweepSummary {
  venuesScanned: number
  totalDetected: number
  totalFixed: number
  totalSkipped: number
  totalErrors: number
  perVenue: Array<{
    venueId: string
    name: string | null
    mode: RemediationMode
    results: Array<Pick<RemediationResult, 'invariantId' | 'violationsDetected' | 'violationsFixed' | 'violationsSkipped'>>
    auditIds: Array<string | null>
  }>
  budgetExhausted: boolean
}

async function loadAutoRemediateFlags(): Promise<Map<string, boolean>> {
  const sb = createServiceClient()
  const out = new Map<string, boolean>()
  const { data, error } = await sb
    .from('venue_config')
    .select('venue_id, feature_flags')
  if (error) {
    console.warn('[integrity_remediation_sweep] venue_config lookup failed:', error.message)
    return out
  }
  for (const row of (data ?? []) as VenueConfigRow[]) {
    const enabled = !!row.feature_flags?.integrity_auto_remediate
    out.set(row.venue_id, enabled)
  }
  return out
}

export async function runIntegrityRemediationSweep(): Promise<SweepSummary> {
  const start = Date.now()
  const sb = createServiceClient()
  const summary: SweepSummary = {
    venuesScanned: 0,
    totalDetected: 0,
    totalFixed: 0,
    totalSkipped: 0,
    totalErrors: 0,
    perVenue: [],
    budgetExhausted: false,
  }

  const { data: venues, error } = await sb
    .from('venues')
    .select('id, name')
    .order('created_at', { ascending: true })
  if (error) {
    console.warn('[integrity_remediation_sweep] venue lookup failed:', error.message)
    return summary
  }

  const autoFlags = await loadAutoRemediateFlags()
  const queue = (venues ?? []) as VenueRow[]

  for (const venue of queue) {
    if (summary.venuesScanned >= PER_TICK_VENUE_LIMIT) {
      summary.budgetExhausted = true
      break
    }
    if (Date.now() - start > TIME_BUDGET_MS) {
      summary.budgetExhausted = true
      break
    }
    const mode: RemediationMode = autoFlags.get(venue.id) ? 'apply' : 'dry_run'
    const startedAt = new Date().toISOString()
    const results = await runAllRemediations({ venueId: venue.id, mode })
    const auditIds: Array<string | null> = []
    for (const r of results) {
      const { id } = await persistRemediationRun({
        venueId: venue.id,
        result: r,
        operatorId: null,
        startedAt,
      })
      auditIds.push(id)
      summary.totalDetected += r.violationsDetected
      summary.totalFixed += r.violationsFixed
      summary.totalSkipped += r.violationsSkipped
      summary.totalErrors += r.errors.length
    }
    summary.venuesScanned += 1
    summary.perVenue.push({
      venueId: venue.id,
      name: venue.name ?? null,
      mode,
      results: results.map((r) => ({
        invariantId: r.invariantId,
        violationsDetected: r.violationsDetected,
        violationsFixed: r.violationsFixed,
        violationsSkipped: r.violationsSkipped,
      })),
      auditIds,
    })
  }

  // Sanity: did we cover all invariants? Defensive log so a future
  // regression where SUPPORTED_INVARIANT_IDS drifts surfaces in logs.
  for (const v of summary.perVenue) {
    if (v.results.length !== SUPPORTED_INVARIANT_IDS.length) {
      console.warn(
        `[integrity_remediation_sweep] venue ${v.venueId} produced ` +
          `${v.results.length} results, expected ${SUPPORTED_INVARIANT_IDS.length}`,
      )
    }
  }

  return summary
}
