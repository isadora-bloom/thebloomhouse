/**
 * Bloom House — Wave 4 Phase 2 enqueue helper.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis — every signal-driven enqueue feeds the same Sonnet judge
 *     that produces couple_identity_profile)
 *   - bloom-wave4-identity-reconstruction.md (Phase 2 wires signal-
 *     driven enqueue + cron drift refresh on top of the Phase 1
 *     foundation)
 *
 * What this module does
 * ---------------------
 * Inserts a row into identity_reconstruction_jobs after a per-wedding
 * 24h dedupe lookup. Callers pass the wedding_id, venue_id, and a free-
 * text trigger label (new_email / calculator_submit / contract_event /
 * calendar_invite / manual_bulk / drift_refresh / admin_backfill).
 *
 * 24h dedupe rationale
 * --------------------
 * A signal-burst (5 inbound emails landing inside one minute on a hot
 * thread) should produce ONE reconstruction, not five. The dedupe
 * window aligns with the cache_window in /api/admin/identity/reconstruct
 * (the single-wedding endpoint also caches for 24h on force=false).
 * Active queued OR running jobs in the last 24h block a fresh enqueue.
 * Done / failed / skipped jobs do NOT block — once a reconstruction has
 * completed, a fresh signal can legitimately re-enqueue.
 *
 * Failure semantics
 * -----------------
 * The helper NEVER throws. Every error path returns
 * `{ skipped: true, reason: '...' }` with a diagnostic reason string.
 * Callers (email pipeline, calendly webhook, contract handler) wrap
 * the call with a fire-and-forget pattern so an enqueue failure cannot
 * fail the load-bearing parent operation (email processing, contract
 * insert, etc.).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h, matches Phase 1 cache window

export interface EnqueueIdentityReconstructionInput {
  weddingId: string
  venueId: string
  triggerSignal: string
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type EnqueueIdentityReconstructionResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

/**
 * Enqueue a Wave-4 identity-reconstruction job. Idempotent within a 24h
 * window per wedding — repeated calls collapse to the first enqueue.
 *
 * Always-safe contract: this function never throws. If the dedupe
 * lookup fails, we treat it as "active job present" (conservative) and
 * skip. If the insert fails, we return `{ skipped: true, reason }` so
 * the caller can log without aborting its parent operation.
 */
export async function enqueueIdentityReconstruction(
  input: EnqueueIdentityReconstructionInput,
): Promise<EnqueueIdentityReconstructionResult> {
  const { weddingId, venueId, triggerSignal } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!weddingId || !venueId) {
    return { skipped: true, reason: 'missing_ids' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  // Dedupe lookup — any active queued/running job in the last 24h for
  // this wedding blocks a fresh enqueue. Uses the
  // idx_identity_reconstruction_jobs_wedding index (mig 260).
  try {
    const { data: existing, error: dedupeErr } = await supabase
      .from('identity_reconstruction_jobs')
      .select('id, status, enqueued_at')
      .eq('wedding_id', weddingId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (dedupeErr) {
      // Conservative: treat as already-active so we don't double-spend.
      console.warn(
        '[enqueueIdentityReconstruction] dedupe lookup failed; skipping',
        { weddingId, error: dedupeErr.message },
      )
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    console.warn(
      '[enqueueIdentityReconstruction] dedupe lookup threw; skipping',
      { weddingId, error: err instanceof Error ? err.message : String(err) },
    )
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  // Insert. If the wedding is gone (cascaded delete) the FK fails —
  // we catch and return a typed skip rather than throwing.
  try {
    const { data: inserted, error: insertErr } = await supabase
      .from('identity_reconstruction_jobs')
      .insert({
        wedding_id: weddingId,
        venue_id: venueId,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()

    if (insertErr || !inserted) {
      console.warn('[enqueueIdentityReconstruction] insert failed', {
        weddingId,
        venueId,
        triggerSignal,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }

    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    console.warn('[enqueueIdentityReconstruction] insert threw', {
      weddingId,
      venueId,
      triggerSignal,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'insert_threw' }
  }
}
