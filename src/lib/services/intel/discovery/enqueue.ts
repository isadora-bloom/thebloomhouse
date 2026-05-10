/**
 * Bloom House — Wave 7A enqueue helper for intel_discovery_jobs.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7A pattern discovery engine)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7A spec)
 *   - feedback_parallel_stream_safety.md (Wave 7A does NOT modify
 *     reconstruct.ts or per-couple-derive.ts directly — other agents
 *     may be touching nearby code. Trigger plumbing is documented as
 *     TODO_TRIGGER below; the reconciliation stream wires it.)
 *   - feedback_always_commit_push.md / feedback_audit_agents_overclaim.md
 *
 * What this module does
 * ---------------------
 * Inserts a row into intel_discovery_jobs after a 24h dedupe lookup. The
 * shape mirrors enqueue-cohort-rollup.ts + enqueue-external-match.ts.
 * Discovery is per-venue only (no per-couple scope) — the engine reads
 * cohort-level evidence, so individual couple events shouldn't fan out
 * to discovery jobs.
 *
 * Trigger sources
 * ---------------
 *   - 'volume_threshold' — fire when the venue accumulates N new
 *     couple_intel rows since the last discovery run (e.g. every 25
 *     derives). See TODO_TRIGGER below — the trigger hook is in
 *     per-couple-derive.ts which Wave 7A does NOT modify directly.
 *   - 'drift_refresh' — fired by discovery_engine_sweep cron weekly.
 *   - 'admin_backfill' — fired by /api/admin/intel/discoveries/run with
 *     force=true.
 *   - 'manual_force' — coordinator UI explicit refresh from the
 *     /intel/discoveries dashboard.
 *
 * 24h dedupe rationale
 * --------------------
 * Same as Wave 5A/5B/5C enqueue helpers. Discovery is the most expensive
 * tier of LLM job (~$0.10-0.30 per Sonnet call) and pacing matters. We
 * collapse same-venue requests within 24h to one queued/running job.
 *
 * Failure semantics
 * -----------------
 * The helper NEVER throws. Every error path returns
 * `{ skipped: true, reason: '...' }`. Callers wrap with fire-and-forget
 * so an enqueue failure cannot fail the load-bearing parent operation.
 *
 * TODO_TRIGGER — volume-threshold hook in per-couple-derive.ts
 * ------------------------------------------------------------
 * Wave 7A wants this enqueued when a venue accumulates N new couple_intel
 * rows. The natural call site is the end of per-couple-derive.ts after
 * the upsert — but per the parallel-stream contract, Wave 7A does NOT
 * modify that file directly (other agents may be touching it). The
 * reconciliation stream after Round 4 closes should add roughly:
 *
 *   import { enqueueDiscoveryRun } from '@/lib/services/intel/discovery/enqueue'
 *   ...
 *   // After the per-couple-derive upsert succeeds:
 *   const sinceLastRun = await countDerivesSinceLastDiscovery(supabase, venueId)
 *   if (sinceLastRun >= 25) {
 *     void enqueueDiscoveryRun({
 *       venueId,
 *       triggerSignal: 'volume_threshold',
 *     })
 *   }
 *
 * Until that hook lands, the cron sweep + admin endpoint cover the
 * trigger surface.
 *
 * TODO_CRON_REGISTRATION — sweep registration
 * -------------------------------------------
 * Cron registration must land in src/app/api/cron/route.ts (job string
 * 'discovery_engine_sweep') and vercel.json — both files are owned by
 * the reconciliation stream during Wave 7A's parallel run with Wave 5D
 * + 6C. See sweep.ts for the full registration TODO.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

export interface EnqueueDiscoveryRunInput {
  venueId: string
  triggerSignal: string
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type EnqueueDiscoveryRunResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

/**
 * Enqueue a Wave-7A discovery job. Idempotent within a 24h window per
 * venue — repeated calls collapse to the first enqueue.
 *
 * Always-safe contract: this function never throws.
 */
export async function enqueueDiscoveryRun(
  input: EnqueueDiscoveryRunInput,
): Promise<EnqueueDiscoveryRunResult> {
  const { venueId, triggerSignal } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!venueId) {
    return { skipped: true, reason: 'missing_venue_id' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  // Dedupe lookup. Active queued OR running jobs in the last 24h block
  // a fresh enqueue.
  try {
    const { data: existing, error: dedupeErr } = await supabase
      .from('intel_discovery_jobs')
      .select('id, status, enqueued_at')
      .eq('venue_id', venueId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (dedupeErr) {
      console.warn(
        '[enqueueDiscoveryRun] dedupe lookup failed; skipping',
        { venueId, error: dedupeErr.message },
      )
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    console.warn(
      '[enqueueDiscoveryRun] dedupe lookup threw; skipping',
      {
        venueId,
        error: err instanceof Error ? err.message : String(err),
      },
    )
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  try {
    const { data: inserted, error: insertErr } = await supabase
      .from('intel_discovery_jobs')
      .insert({
        venue_id: venueId,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()

    if (insertErr || !inserted) {
      console.warn('[enqueueDiscoveryRun] insert failed', {
        venueId,
        triggerSignal,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }

    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    console.warn('[enqueueDiscoveryRun] insert threw', {
      venueId,
      triggerSignal,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'insert_threw' }
  }
}
