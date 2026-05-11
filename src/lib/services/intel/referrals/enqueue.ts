/**
 * Bloom House — Wave 14 enqueue helper for referral_extraction_jobs.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction is the
 *     thesis; Wave 14 is a sibling extractor that runs AFTER the Wave 4
 *     forensic profile lands, never modifying reconstruct.ts)
 *   - bloom-wave4-identity-reconstruction.md (reconstruct.ts is sealed)
 *   - feedback_always_commit_push.md / feedback_audit_agents_overclaim.md
 *
 * What this module does
 * ---------------------
 * Inserts a row into referral_extraction_jobs after a per-wedding 24h
 * dedupe lookup. Mirrors enqueue-couple-intel.ts shape (Wave 5A). The
 * trigger labels we expect are: 'profile_updated' (fired post-Wave-4),
 * 'manual_bulk', 'drift_refresh', 'admin_backfill'.
 *
 * Failure semantics
 * -----------------
 * The helper NEVER throws. Every error path returns
 * `{ skipped: true, reason: '...' }` with a diagnostic reason string.
 * Callers wrap the call with a fire-and-forget pattern so an enqueue
 * failure cannot fail the load-bearing parent operation.
 *
 * TODO_HOOK
 * ---------
 * Wave 14 intentionally does NOT modify reconstruct.ts (sealed per
 * the Wave 4 doctrine). The wire-up point is at the end of
 * reconstructCoupleIdentity, alongside the existing enqueueCoupleIntel
 * fire-and-forget call. After Wave 11 + Wave 14 land, reconciliation
 * should add:
 *
 *   try {
 *     const { enqueueReferralExtraction } = await import(
 *       '@/lib/services/intel/referrals/enqueue'
 *     )
 *     await enqueueReferralExtraction({
 *       weddingId, venueId, triggerSignal: 'profile_updated', supabase,
 *     })
 *   } catch (err) {
 *     console.warn('[reconstruct] referral-extraction enqueue threw:', err)
 *   }
 *
 * Until then: callers can invoke enqueueReferralExtraction directly
 * (manual-bulk path), and the sweep handles drift_refresh on its own.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000 // 24h

export interface EnqueueReferralExtractionInput {
  weddingId: string
  venueId: string
  triggerSignal: string
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type EnqueueReferralExtractionResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

export async function enqueueReferralExtraction(
  input: EnqueueReferralExtractionInput,
): Promise<EnqueueReferralExtractionResult> {
  const { weddingId, venueId, triggerSignal } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!weddingId || !venueId) {
    return { skipped: true, reason: 'missing_ids' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  // Dedupe lookup — any active queued/running job in the last 24h for
  // this wedding blocks a fresh enqueue.
  try {
    const { data: existing, error: dedupeErr } = await supabase
      .from('referral_extraction_jobs')
      .select('id, status, enqueued_at')
      .eq('wedding_id', weddingId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (dedupeErr) {
      console.warn(
        '[enqueueReferralExtraction] dedupe lookup failed; skipping',
        { weddingId, error: dedupeErr.message },
      )
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    console.warn(
      '[enqueueReferralExtraction] dedupe lookup threw; skipping',
      { weddingId, error: err instanceof Error ? err.message : String(err) },
    )
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  // Insert. FK failure (wedding deleted between enqueue trigger + insert)
  // is caught and returned as a typed skip rather than thrown.
  try {
    const { data: inserted, error: insertErr } = await supabase
      .from('referral_extraction_jobs')
      .insert({
        wedding_id: weddingId,
        venue_id: venueId,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()

    if (insertErr || !inserted) {
      console.warn('[enqueueReferralExtraction] insert failed', {
        weddingId,
        venueId,
        triggerSignal,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }
    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    console.warn('[enqueueReferralExtraction] insert threw', {
      weddingId,
      venueId,
      triggerSignal,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'insert_threw' }
  }
}
