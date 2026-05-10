/**
 * Bloom House — Wave 5A enqueue helper for couple_intel_jobs.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5A is the action layer derived from
 *     the Wave 4 forensic profile)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5A spec)
 *   - feedback_always_commit_push.md / feedback_audit_agents_overclaim.md
 *
 * What this module does
 * ---------------------
 * Inserts a row into couple_intel_jobs after a per-wedding 24h dedupe
 * lookup. Mirrors enqueue-reconstruction.ts for Wave 4. Callers pass
 * the wedding_id, venue_id, and a free-text trigger label
 * ('profile_updated', 'manual_bulk', 'drift_refresh', 'admin_backfill').
 *
 * 24h dedupe rationale
 * --------------------
 * Same as Wave 4's enqueue helper. A burst (5 reconstructs in 60s)
 * should produce ONE intel derive, not five. Active queued OR running
 * jobs in the last 24h block a fresh enqueue. Done / failed / skipped
 * jobs do NOT block — once a derive has completed, a fresh signal can
 * legitimately re-enqueue.
 *
 * Failure semantics
 * -----------------
 * The helper NEVER throws. Every error path returns
 * `{ skipped: true, reason: '...' }` with a diagnostic reason string.
 * Callers (reconstruct.ts, manual-bulk endpoint, drift sweep) wrap the
 * call with a fire-and-forget pattern so an enqueue failure cannot
 * fail the load-bearing parent operation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

export interface EnqueueCoupleIntelInput {
  weddingId: string
  venueId: string
  triggerSignal: string
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type EnqueueCoupleIntelResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

/**
 * Enqueue a Wave-5A intel-derive job. Idempotent within a 24h window
 * per wedding — repeated calls collapse to the first enqueue.
 *
 * Always-safe contract: this function never throws.
 */
export async function enqueueCoupleIntel(
  input: EnqueueCoupleIntelInput,
): Promise<EnqueueCoupleIntelResult> {
  const { weddingId, venueId, triggerSignal } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!weddingId || !venueId) {
    return { skipped: true, reason: 'missing_ids' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  // Dedupe lookup — any active queued/running job in the last 24h for
  // this wedding blocks a fresh enqueue. Uses the
  // idx_couple_intel_jobs_wedding index (mig 261).
  try {
    const { data: existing, error: dedupeErr } = await supabase
      .from('couple_intel_jobs')
      .select('id, status, enqueued_at')
      .eq('wedding_id', weddingId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (dedupeErr) {
      // Conservative: treat as already-active so we don't double-spend.
      console.warn(
        '[enqueueCoupleIntel] dedupe lookup failed; skipping',
        { weddingId, error: dedupeErr.message },
      )
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    console.warn(
      '[enqueueCoupleIntel] dedupe lookup threw; skipping',
      { weddingId, error: err instanceof Error ? err.message : String(err) },
    )
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  // Insert. If the wedding is gone (cascaded delete) the FK fails —
  // we catch and return a typed skip rather than throwing.
  try {
    const { data: inserted, error: insertErr } = await supabase
      .from('couple_intel_jobs')
      .insert({
        wedding_id: weddingId,
        venue_id: venueId,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()

    if (insertErr || !inserted) {
      console.warn('[enqueueCoupleIntel] insert failed', {
        weddingId,
        venueId,
        triggerSignal,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }

    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    console.warn('[enqueueCoupleIntel] insert threw', {
      weddingId,
      venueId,
      triggerSignal,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'insert_threw' }
  }
}
