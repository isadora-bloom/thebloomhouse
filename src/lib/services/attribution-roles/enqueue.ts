/**
 * Wave 7B — channel-role classifier enqueue helper.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction)
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B spec)
 *
 * Mirrors the Wave 4 / Wave 5A enqueue pattern: 24h dedupe per
 * attribution_event, fire-and-forget contract (never throws), so
 * callers (candidate-resolver, identity-backtrack, manual bulk paths)
 * can wire a fire-and-forget hook without risk of failing their parent
 * operation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface EnqueueRoleClassificationInput {
  attributionEventId: string
  venueId: string
  triggerSignal: string
  /** Optional client override. Defaults to service-role. */
  supabase?: SupabaseClient
}

export type EnqueueRoleClassificationResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

/**
 * Enqueue a Wave-7B channel-role classification job. Idempotent within a
 * 24h window per attribution_event. Always-safe: never throws.
 */
export async function enqueueRoleClassification(
  input: EnqueueRoleClassificationInput,
): Promise<EnqueueRoleClassificationResult> {
  const { attributionEventId, venueId, triggerSignal } = input
  const sb = input.supabase ?? createServiceClient()

  if (!attributionEventId || !venueId) {
    return { skipped: true, reason: 'missing_ids' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  // Dedupe lookup. Conservative on lookup failure — skip rather than
  // double-spend.
  try {
    const { data: existing, error: dedupeErr } = await sb
      .from('attribution_role_jobs')
      .select('id, status, enqueued_at')
      .eq('attribution_event_id', attributionEventId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (dedupeErr) {
      console.warn('[enqueueRoleClassification] dedupe lookup failed; skipping', {
        attributionEventId,
        error: dedupeErr.message,
      })
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    console.warn('[enqueueRoleClassification] dedupe lookup threw; skipping', {
      attributionEventId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  try {
    const { data: inserted, error: insertErr } = await sb
      .from('attribution_role_jobs')
      .insert({
        attribution_event_id: attributionEventId,
        venue_id: venueId,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()
    if (insertErr || !inserted) {
      console.warn('[enqueueRoleClassification] insert failed', {
        attributionEventId,
        venueId,
        triggerSignal,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }
    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    console.warn('[enqueueRoleClassification] insert threw', {
      attributionEventId,
      venueId,
      triggerSignal,
      error: err instanceof Error ? err.message : String(err),
    })
    return { skipped: true, reason: 'insert_threw' }
  }
}
