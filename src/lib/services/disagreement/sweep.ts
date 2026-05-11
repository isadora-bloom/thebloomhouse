/**
 * Bloom House — Wave 17 disagreement sweep.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - feedback_self_reported_sources_not_truth.md
 *
 * Sweeper for the disagreement-surfacing pipeline. Drains the
 * disagreement_jobs queue (50/tick). For each enqueued (venue_id,
 * wedding_id) pair, runs the detector + narrator. When there is no
 * queue backlog, falls through to a drift refresh: pick venues with
 * stale last_observed_at across their active findings.
 *
 * Cron wiring is TODO — when the reconciliation stream registers
 * job=disagreement_sweep in src/app/api/cron/route.ts +
 * vercel.json, this is what it calls. The current Wave 17 patch
 * leaves the cron registration alone (per merge-safety zones); this
 * function is callable manually via the admin endpoint.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { detectDisagreements } from './detect'
import { narrateDisagreements } from './narrate'

interface SweepArgs {
  /** Cap on weddings scanned per tick. */
  batchSize?: number
  supabase?: SupabaseClient
}

interface SweepResult {
  picked: number
  scanned: number
  written: number
  refreshed: number
  narrated: number
  narratorCostCents: number
  errors: string[]
}

interface QueueRow {
  id: string
  venue_id: string
  wedding_id: string | null
}

// TODO(cron): register job=disagreement_sweep in src/app/api/cron/route.ts
//   + an entry in vercel.json once the reconciliation stream lands.
//   The cron handler should call:
//     await runDisagreementSweep({ batchSize: 50 })
//
//   Frequency suggestion: every 6h — disagreement signal is not
//   real-time critical; once-per-business-quarter cadence per wedding
//   is sufficient. Drift refresh handles long-tail recomputation.

export async function runDisagreementSweep(
  args: SweepArgs = {},
): Promise<SweepResult> {
  const supabase = args.supabase ?? createServiceClient()
  const batchSize = args.batchSize ?? 50
  const errors: string[] = []
  let picked = 0
  let scanned = 0
  let written = 0
  let refreshed = 0
  let narrated = 0
  let narratorCostCents = 0

  // Step 1: drain the queue.
  const { data: queueRaw, error: qErr } = await supabase
    .from('disagreement_jobs')
    .select('id, venue_id, wedding_id')
    .eq('status', 'queued')
    .order('enqueued_at', { ascending: true })
    .limit(batchSize)
  if (qErr) {
    errors.push(`load queue: ${qErr.message}`)
  }
  const queue = (queueRaw ?? []) as QueueRow[]
  picked = queue.length

  // Group by venue so we can run narrate-batch per venue once at the end.
  const venuesTouched = new Set<string>()

  for (const job of queue) {
    // Mark running.
    await supabase
      .from('disagreement_jobs')
      .update({ status: 'running', started_at: new Date().toISOString() })
      .eq('id', job.id)

    try {
      const result = job.wedding_id
        ? await detectDisagreements({
            weddingId: job.wedding_id,
            supabase,
          })
        : await detectDisagreements({
            venueId: job.venue_id,
            supabase,
            limit: 50,
          })
      scanned += result.scanned
      written += result.written
      refreshed += result.refreshed
      for (const e of result.errors) errors.push(`job ${job.id}: ${e}`)
      venuesTouched.add(job.venue_id)
      await supabase
        .from('disagreement_jobs')
        .update({
          status: 'done',
          completed_at: new Date().toISOString(),
        })
        .eq('id', job.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`job ${job.id}: ${msg}`)
      await supabase
        .from('disagreement_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_text: msg,
        })
        .eq('id', job.id)
    }
  }

  // Step 2: narrate uncached active findings for the venues we touched.
  for (const venueId of venuesTouched) {
    try {
      const r = await narrateDisagreements({
        venueId,
        limit: 20,
        supabase,
      })
      narrated += r.narrated
      narratorCostCents += r.totalCostCents
      for (const e of r.errors) errors.push(`narrate ${venueId}: ${e}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      errors.push(`narrate ${venueId}: ${msg}`)
    }
  }

  return {
    picked,
    scanned,
    written,
    refreshed,
    narrated,
    narratorCostCents,
    errors,
  }
}
