// ---------------------------------------------------------------------------
// lifecycle/writer.ts -- transition writer: engine + DB UPDATE + event log.
// ---------------------------------------------------------------------------
//
// The pure engine returns "what should happen". This module performs the
// I/O. It is deliberately small so the email pipeline (and any future
// caller -- HoneyBook webhook, Calendly hook, coordinator drag-drop) only
// has to:
//
//   1) detect / declare a LifecycleSignal,
//   2) call applyLifecycleSignal(...),
//   3) keep going.
//
// applyLifecycleSignal handles:
//   - reading the current weddings.status,
//   - asking the engine for the legal next status,
//   - if legal: UPDATE weddings.status + INSERT
//     wedding_lifecycle_events row with status_from / status_to / reason,
//   - if illegal: INSERT a "violation" wedding_lifecycle_events row
//     (signal prefixed 'violation:') so coordinators see drift in the
//     same audit feed they already use for legitimate transitions.
//
// Best-effort: any DB error is caught and logged. The lifecycle writer
// must never throw inside the email pipeline, otherwise a Supabase blip
// could nuke the auto-draft path for an unrelated reason. Pipeline +
// crons are responsible for their own error reporting.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isTerminalStatus,
  nextStatus,
  type LifecycleSignal,
  type WeddingStatus,
} from './wedding-lifecycle-engine'

export interface ApplyLifecycleSignalArgs {
  supabase: SupabaseClient
  venueId: string
  weddingId: string
  signal: LifecycleSignal
  detectedBy: 'ai' | 'pipeline' | 'coordinator' | 'webhook' | 'cron' | 'backfill'
  /** Interaction the signal was detected on (if any). */
  sourceInteractionId?: string | null
  /** AI confidence 0-100 when detectedBy='ai'. */
  confidence?: number | null
  /** Optional reason override -- defaults to engine-supplied reason. */
  reason?: string | null
}

export interface ApplyLifecycleSignalResult {
  applied: boolean
  from: WeddingStatus | null
  to: WeddingStatus | null
  reason: string
  /** True when the engine refused (transition was illegal for current state). */
  violation: boolean
}

/**
 * Apply a lifecycle signal to a wedding. Reads current status, runs the
 * engine, performs the UPDATE + event log atomically (best-effort -- two
 * separate writes; the event log is more important to land than the
 * UPDATE because a missing event log loses audit, while a missing UPDATE
 * is recoverable from the event log on the next signal arrival).
 *
 * Never throws. On any error, returns { applied: false, ... } and logs
 * via console.warn so the email pipeline doesn't bleed.
 */
export async function applyLifecycleSignal(
  args: ApplyLifecycleSignalArgs,
): Promise<ApplyLifecycleSignalResult> {
  const { supabase, venueId, weddingId, signal, detectedBy } = args

  let currentStatus: WeddingStatus | null = null
  try {
    const { data: row } = await supabase
      .from('weddings')
      .select('status')
      .eq('id', weddingId)
      .maybeSingle()
    if (row) {
      currentStatus = (row.status as WeddingStatus | undefined) ?? null
    }
  } catch (err) {
    console.warn('[lifecycle] read current status failed:', err)
    return {
      applied: false,
      from: null,
      to: null,
      reason: 'read failed',
      violation: false,
    }
  }

  if (!currentStatus) {
    // No row found -- can't transition something that doesn't exist.
    return {
      applied: false,
      from: null,
      to: null,
      reason: 'wedding not found',
      violation: false,
    }
  }

  // Terminal states are off-limits to signal-driven transitions. The
  // engine itself enforces this for most paths but explicitly checking
  // here lets us record a "violation:" event with the right context
  // ("attempted contract_signed on lost wedding -- coordinator review").
  const decision = nextStatus(currentStatus, signal)

  if (!decision) {
    // Illegal pair. Two sub-cases:
    //   (a) it's a no-op the engine doesn't care about (e.g. a
    //       tour_scheduled signal on a wedding already in
    //       tour_scheduled). We don't log violations for those -- they
    //       would flood the audit feed.
    //   (b) it's a real drift signal (e.g. contract_signed on a 'lost'
    //       wedding). We DO log this so coordinators see the
    //       inconsistency and can manually reopen if appropriate.
    //
    // Heuristic: if the current state is terminal, log as violation.
    // Otherwise treat as no-op.
    const isViolation = isTerminalStatus(currentStatus)
    if (isViolation) {
      try {
        await supabase.from('wedding_lifecycle_events').insert({
          venue_id: venueId,
          wedding_id: weddingId,
          signal: 'violation:' + signal,
          status_from: currentStatus,
          status_to: null,
          reason:
            args.reason ??
            'engine refused: signal incompatible with terminal state ' + currentStatus,
          detected_by: detectedBy,
          source_interaction_id: args.sourceInteractionId ?? null,
          confidence: args.confidence ?? null,
        })
      } catch (err) {
        console.warn('[lifecycle] violation log failed:', err)
      }
    }
    return {
      applied: false,
      from: currentStatus,
      to: null,
      reason: isViolation ? 'engine refused (terminal state)' : 'no-op',
      violation: isViolation,
    }
  }

  // Legal transition. UPDATE + INSERT in parallel -- they don't depend
  // on each other.
  const reason = args.reason ?? decision.reason
  try {
    const updatePromise = supabase
      .from('weddings')
      .update(buildStatusUpdatePayload(decision.to))
      .eq('id', weddingId)

    const eventPromise = supabase.from('wedding_lifecycle_events').insert({
      venue_id: venueId,
      wedding_id: weddingId,
      signal,
      status_from: currentStatus,
      status_to: decision.to,
      reason,
      detected_by: detectedBy,
      source_interaction_id: args.sourceInteractionId ?? null,
      confidence: args.confidence ?? null,
    })

    const [{ error: updErr }, { error: evtErr }] = await Promise.all([
      updatePromise,
      eventPromise,
    ])

    if (updErr) {
      console.warn('[lifecycle] status update failed:', updErr.message)
    }
    if (evtErr) {
      console.warn('[lifecycle] event log insert failed:', evtErr.message)
    }
  } catch (err) {
    console.warn('[lifecycle] apply transition failed:', err)
    return {
      applied: false,
      from: currentStatus,
      to: decision.to,
      reason,
      violation: false,
    }
  }

  return {
    applied: true,
    from: currentStatus,
    to: decision.to,
    reason,
    violation: false,
  }
}

/**
 * Side fields the lifecycle owns when transitioning. Heat-mapping has
 * its own "set heat to 100 / 0" path on direct mark-as-booked /
 * mark-as-lost calls; the AI-driven path does NOT touch heat (heat is
 * computed elsewhere from engagement_events and we don't want two
 * sources writing it). We DO stamp lost_at / booked_at / cancelled_at
 * timestamps because intel + cron jobs depend on them.
 */
function buildStatusUpdatePayload(to: WeddingStatus): Record<string, unknown> {
  const now = new Date().toISOString()
  const payload: Record<string, unknown> = {
    status: to,
    updated_at: now,
  }
  if (to === 'lost') {
    payload.lost_at = now
  }
  if (to === 'booked') {
    payload.booked_at = now
  }
  if (to === 'cancelled') {
    payload.cancelled_at = now
  }
  return payload
}
