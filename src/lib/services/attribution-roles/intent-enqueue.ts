/**
 * Wave 16 — inquiry-intent classifier enqueue helper.
 *
 * Mirrors the Wave 7B enqueueRoleClassification pattern: 24h dedupe
 * per attribution_event, fire-and-forget contract (never throws).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000

export interface EnqueueIntentClassificationInput {
  attributionEventId: string
  venueId: string
  triggerSignal: string
  supabase?: SupabaseClient
}

export type EnqueueIntentClassificationResult =
  | { skipped: true; reason: string }
  | { skipped: false; jobId: string }

export async function enqueueIntentClassification(
  input: EnqueueIntentClassificationInput,
): Promise<EnqueueIntentClassificationResult> {
  const { attributionEventId, venueId, triggerSignal } = input
  const sb = input.supabase ?? createServiceClient()

  if (!attributionEventId || !venueId) {
    return { skipped: true, reason: 'missing_ids' }
  }

  const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString()

  try {
    const { data: existing, error: dedupeErr } = await sb
      .from('attribution_intent_jobs')
      .select('id, status, enqueued_at')
      .eq('attribution_event_id', attributionEventId)
      .in('status', ['queued', 'running'])
      .gte('enqueued_at', sinceIso)
      .limit(1)
      .maybeSingle()

    if (dedupeErr) {
      console.warn('[enqueueIntentClassification] dedupe lookup failed; skipping', {
        attributionEventId,
        error: dedupeErr.message,
      })
      return { skipped: true, reason: 'dedupe_lookup_failed' }
    }
    if (existing) {
      return { skipped: true, reason: 'dedupe_24h' }
    }
  } catch (err) {
    return { skipped: true, reason: 'dedupe_lookup_threw' }
  }

  try {
    const { data: inserted, error: insertErr } = await sb
      .from('attribution_intent_jobs')
      .insert({
        attribution_event_id: attributionEventId,
        venue_id: venueId,
        status: 'queued',
        trigger_signal: triggerSignal,
      })
      .select('id')
      .single()
    if (insertErr || !inserted) {
      console.warn('[enqueueIntentClassification] insert failed', {
        attributionEventId,
        error: insertErr?.message,
      })
      return { skipped: true, reason: 'insert_failed' }
    }
    return { skipped: false, jobId: (inserted as { id: string }).id }
  } catch (err) {
    return { skipped: true, reason: 'insert_threw' }
  }
}
