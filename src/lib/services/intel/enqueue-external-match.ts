/**
 * Bloom House — Wave 5C enqueue helper for intel_match_jobs.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5C external-signal matching layer)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5C spec)
 *   - feedback_always_commit_push.md / feedback_audit_agents_overclaim.md
 *
 * What this module does
 * ---------------------
 * Inserts a row into intel_match_jobs after a 24h dedupe lookup. Mirrors
 * enqueue-cohort-rollup.ts. Callers pass venue_id (always required) and
 * an optional wedding_id (per-couple scope) plus a free-text trigger
 * label.
 *
 * Trigger sources
 * ---------------
 *   - 'profile_change' — fired from reconstruct.ts after the
 *     couple_identity_profile upsert + persona-overlay enqueue (TODO:
 *     reconciliation stream wires this hook; see TODO_RECONCILE below).
 *   - 'drift_refresh' — fired by external_match_sweep cron once per
 *     venue per 6h.
 *   - 'admin_backfill' — fired by /api/admin/intel/external-matches/scan
 *     with force=true.
 *   - 'manual_force' — coordinator UI explicit refresh.
 *
 * 24h dedupe rationale
 * --------------------
 * Same as Wave 5A/5B's enqueue helpers. Rapid signals shouldn't multi-
 * fire scans. Active queued OR running jobs in the last 24h block a
 * fresh enqueue per (venue, wedding) scope.
 *
 * Failure semantics
 * -----------------
 * The helper NEVER throws. Every error path returns
 * `{ skipped: true, reason: '...' }`. Callers wrap with fire-and-forget
 * so an enqueue failure cannot fail the load-bearing parent operation.
 *
 * TODO_RECONCILE — reconstruct.ts hook
 * ------------------------------------
 * Wave 5C wants this called immediately after reconstruct.ts upserts
 * couple_identity_profile + enqueues the Wave 5A/5B follow-ups. The
 * call site:
 *
 *   import { enqueueExternalMatch } from '@/lib/services/intel/enqueue-external-match'
 *   ...
 *   void enqueueExternalMatch({
 *     venueId,
 *     weddingId,
 *     triggerSignal: 'profile_change',
 *   })
 *
 * Per the Wave 5C parallel-stream contract (memory/feedback_parallel_
 * stream_safety.md), Wave 5C does NOT modify reconstruct.ts directly —
 * other agents may be touching nearby code. The reconciliation stream
 * after Round 3 closes should add this single line. Document only here
 * to keep the change boundary clean.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

export interface EnqueueExternalMatchInput {
  venueId: string
  /** Per-couple scope. Null/undefined for venue-wide drift refresh. */
  weddingId?: string | null
  triggerSignal: string
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type EnqueueExternalMatchResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

/**
 * Enqueue a Wave-5C external-match job. Idempotent within a 24h window
 * per (venue, wedding) scope — repeated calls collapse to the first
 * enqueue.
 *
 * Always-safe contract: this function never throws.
 */
export async function enqueueExternalMatch(
  input: EnqueueExternalMatchInput,
): Promise<EnqueueExternalMatchResult> {
  const { venueId, weddingId, triggerSignal } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!venueId) {
    return { skipped: true, reason: 'missing_venue_id' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  // Dedupe lookup. Per (venue, wedding-or-null) scope: a venue-level
  // drift_refresh shouldn't be blocked by a per-couple profile_change
  // and vice versa.
  try {
    let dedupeQuery = supabase
      .from('intel_match_jobs')
      .select('id, status, enqueued_at, wedding_id')
      .eq('venue_id', venueId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
    if (weddingId) {
      dedupeQuery = dedupeQuery.eq('wedding_id', weddingId)
    } else {
      dedupeQuery = dedupeQuery.is('wedding_id', null)
    }
    const { data: existing, error: dedupeErr } = await dedupeQuery.maybeSingle()

    if (dedupeErr) {
      console.warn(
        '[enqueueExternalMatch] dedupe lookup failed; skipping',
        { venueId, weddingId, error: dedupeErr.message },
      )
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    console.warn(
      '[enqueueExternalMatch] dedupe lookup threw; skipping',
      { venueId, weddingId, error: err instanceof Error ? err.message : String(err) },
    )
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  try {
    const { data: inserted, error: insertErr } = await supabase
      .from('intel_match_jobs')
      .insert({
        venue_id: venueId,
        wedding_id: weddingId ?? null,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()

    if (insertErr || !inserted) {
      console.warn('[enqueueExternalMatch] insert failed', {
        venueId,
        weddingId,
        triggerSignal,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }

    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    console.warn('[enqueueExternalMatch] insert threw', {
      venueId,
      weddingId,
      triggerSignal,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'insert_threw' }
  }
}
