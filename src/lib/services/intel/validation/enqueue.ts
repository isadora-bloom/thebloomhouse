/**
 * Bloom House — Wave 7C enqueue helper for hypothesis_validation_jobs.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7C closes the discovery loop)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7C spec — validations are
 *     two Sonnet calls + a query, paced at 3 jobs per sweep tick)
 *   - feedback_parallel_stream_safety.md (Wave 7C does NOT modify
 *     intel/discovery/engine.ts directly — Wave 7A's discovery code is
 *     read-only here. The trigger hook is documented as TODO_TRIGGER
 *     below; the reconciliation stream wires it.)
 *
 * What this module does
 * ---------------------
 * Inserts a row into hypothesis_validation_jobs after a 24h dedupe
 * lookup keyed on discovery_id (NOT venue_id — multiple distinct
 * discoveries on the same venue should each get their own validation).
 *
 * Trigger sources
 * ---------------
 *   - 'high_confidence_discovery' — fired immediately when Wave 7A
 *     produces a discovery with confidence >= 70 AND the venue has
 *     opted in via venue_config.auto_validate_high_confidence_discoveries
 *     (configurable; defaults off until cohort substrate is mature).
 *     See TODO_TRIGGER below.
 *   - 'drift_refresh' — fired by hypothesis_validation_sweep cron weekly
 *     for any in_progress discovery whose last validation_completed_at
 *     is > 7 days old (cohort may have grown since then; re-run can
 *     flip inconclusive → validated).
 *   - 'admin_backfill' — POST /api/admin/intel/discoveries/{id}/validate.
 *   - 'manual_force' — coordinator UI explicit "validate now" button.
 *
 * 24h dedupe rationale
 * --------------------
 * Same as Wave 5/6/7A enqueue helpers. Validation is two Sonnet calls
 * (~$0.05-0.15) and pacing matters. Discovery-keyed dedupe (vs
 * venue-keyed in Wave 7A) lets multiple discoveries on the same venue
 * each get their own queued job in parallel, but a single discovery
 * can only be queued once per 24h.
 *
 * Failure semantics
 * -----------------
 * The helper NEVER throws. Every error path returns
 * `{ skipped: true, reason: '...' }`. Callers wrap with fire-and-forget.
 *
 * TODO_TRIGGER — high-confidence-discovery hook in engine.ts
 * ----------------------------------------------------------
 * Wave 7C wants this enqueued at the end of runDiscoveryEngine when a
 * just-inserted discovery has confidence_0_100 >= 70 AND the venue has
 * opted in. Per the parallel-stream contract Wave 7C does NOT modify
 * Wave 7A's engine.ts directly. The reconciliation stream (or a
 * follow-up Wave 7C wiring task) should add roughly:
 *
 *   import { enqueueHypothesisValidation } from
 *     '@/lib/services/intel/validation/enqueue'
 *
 *   // After successfully inserting an intel_discoveries row:
 *   if (insertedDiscovery.confidence_0_100 >= 70 &&
 *       venueConfig.auto_validate_high_confidence_discoveries === true) {
 *     void enqueueHypothesisValidation({
 *       discoveryId: insertedDiscovery.id,
 *       venueId,
 *       triggerSignal: 'high_confidence_discovery',
 *     })
 *   }
 *
 * Until that hook lands, the cron sweep + admin endpoint cover the
 * trigger surface.
 *
 * TODO_CRON_REGISTRATION — sweep registration
 * -------------------------------------------
 * Cron registration must land in src/app/api/cron/route.ts (job string
 * 'hypothesis_validation_sweep') and src/lib/cron-auth.ts (add to
 * DESTRUCTIVE_JOBS), and vercel.json. All three files are owned by
 * the reconciliation stream during Wave 7C's parallel run. See sweep.ts
 * for the full registration TODO.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

export interface EnqueueHypothesisValidationInput {
  discoveryId: string
  venueId: string
  triggerSignal: string
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type EnqueueHypothesisValidationResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

/**
 * Enqueue a Wave-7C validation job. Idempotent within a 24h window per
 * discovery — repeated calls collapse to the first enqueue.
 *
 * Always-safe contract: this function never throws.
 */
export async function enqueueHypothesisValidation(
  input: EnqueueHypothesisValidationInput,
): Promise<EnqueueHypothesisValidationResult> {
  const { discoveryId, venueId, triggerSignal } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!discoveryId) {
    return { skipped: true, reason: 'missing_discovery_id' }
  }
  if (!venueId) {
    return { skipped: true, reason: 'missing_venue_id' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  // Dedupe on discovery_id — see module header.
  try {
    const { data: existing, error: dedupeErr } = await supabase
      .from('hypothesis_validation_jobs')
      .select('id, status, enqueued_at')
      .eq('discovery_id', discoveryId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (dedupeErr) {
      console.warn(
        '[enqueueHypothesisValidation] dedupe lookup failed; skipping',
        { discoveryId, error: dedupeErr.message },
      )
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    console.warn(
      '[enqueueHypothesisValidation] dedupe lookup threw; skipping',
      {
        discoveryId,
        error: err instanceof Error ? err.message : String(err),
      },
    )
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  try {
    const { data: inserted, error: insertErr } = await supabase
      .from('hypothesis_validation_jobs')
      .insert({
        venue_id: venueId,
        discovery_id: discoveryId,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()

    if (insertErr || !inserted) {
      console.warn('[enqueueHypothesisValidation] insert failed', {
        discoveryId,
        venueId,
        triggerSignal,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }

    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    console.warn('[enqueueHypothesisValidation] insert threw', {
      discoveryId,
      venueId,
      triggerSignal,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'insert_threw' }
  }
}
