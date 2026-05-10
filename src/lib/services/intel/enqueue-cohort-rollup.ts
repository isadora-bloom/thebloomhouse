/**
 * Bloom House — Wave 5B enqueue helper for venue_intel_jobs.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5B aggregates the per-couple substrate
 *     into venue-level intel)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5B spec)
 *   - feedback_always_commit_push.md / feedback_audit_agents_overclaim.md
 *
 * What this module does
 * ---------------------
 * Inserts a row into venue_intel_jobs after a per-venue 24h dedupe
 * lookup. Mirrors enqueue-couple-intel.ts. Callers pass venue_id and a
 * free-text trigger label ('weekly_cron', 'manual_bulk',
 * 'drift_refresh', 'admin_backfill').
 *
 * 24h dedupe rationale
 * --------------------
 * Same as Wave 5A's enqueue helper. Manual force + cron drift firing
 * close together should produce ONE rollup, not two. Active queued OR
 * running jobs in the last 24h block a fresh enqueue. Done / failed /
 * skipped jobs do NOT block — once a rollup has completed, a fresh
 * signal (e.g. weekly cron after 7 days) can legitimately re-enqueue.
 *
 * Failure semantics
 * -----------------
 * The helper NEVER throws. Every error path returns
 * `{ skipped: true, reason: '...' }` with a diagnostic reason string.
 * Callers wrap the call with a fire-and-forget pattern so an enqueue
 * failure cannot fail the load-bearing parent operation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

export interface EnqueueCohortRollupInput {
  venueId: string
  triggerSignal: string
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type EnqueueCohortRollupResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

/**
 * Enqueue a Wave-5B cohort-rollup job. Idempotent within a 24h window
 * per venue — repeated calls collapse to the first enqueue.
 *
 * Always-safe contract: this function never throws.
 */
export async function enqueueCohortRollup(
  input: EnqueueCohortRollupInput,
): Promise<EnqueueCohortRollupResult> {
  const { venueId, triggerSignal } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!venueId) {
    return { skipped: true, reason: 'missing_venue_id' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  // Dedupe lookup — any active queued/running job in the last 24h for
  // this venue blocks a fresh enqueue. Uses the
  // idx_venue_intel_jobs_venue index (mig 262).
  try {
    const { data: existing, error: dedupeErr } = await supabase
      .from('venue_intel_jobs')
      .select('id, status, enqueued_at')
      .eq('venue_id', venueId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (dedupeErr) {
      // Conservative: treat as already-active so we don't double-spend.
      console.warn(
        '[enqueueCohortRollup] dedupe lookup failed; skipping',
        { venueId, error: dedupeErr.message },
      )
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    console.warn(
      '[enqueueCohortRollup] dedupe lookup threw; skipping',
      { venueId, error: err instanceof Error ? err.message : String(err) },
    )
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  try {
    const { data: inserted, error: insertErr } = await supabase
      .from('venue_intel_jobs')
      .insert({
        venue_id: venueId,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()

    if (insertErr || !inserted) {
      console.warn('[enqueueCohortRollup] insert failed', {
        venueId,
        triggerSignal,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }

    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    console.warn('[enqueueCohortRollup] insert threw', {
      venueId,
      triggerSignal,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'insert_threw' }
  }
}
