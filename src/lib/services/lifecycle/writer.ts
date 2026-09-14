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
  type BookingCorroboration,
  type LifecycleSignal,
  type WeddingStatus,
} from './wedding-lifecycle-engine'
import { writeOrLog } from '@/lib/db/write-or-log'

/** Signals whose target is 'booked' — the ones that need corroborating. */
const BOOKING_SIGNALS: ReadonlySet<LifecycleSignal> = new Set<LifecycleSignal>([
  'contract_signed',
  'deposit_paid',
])

/**
 * Look for non-text evidence that this wedding really did book
 * (2026-09-14 ingestion audit item 3).
 *
 * Three independent sources, any one of which is enough:
 *   - a `contracts` row for the wedding with status 'signed' (W57,
 *     migration 409 — generated contracts move draft → sent → viewed →
 *     signed and the signing route is the only writer of 'signed'),
 *   - a `budget_payments` row against the wedding (migration 017),
 *   - the caller is a coordinator acting deliberately, which is itself
 *     the corroboration.
 *
 * Reads fail SOFT to "no evidence": a Supabase blip must not manufacture
 * a booking. The proposal path is the safe default.
 */
async function loadBookingCorroboration(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  detectedBy: ApplyLifecycleSignalArgs['detectedBy'],
): Promise<BookingCorroboration> {
  const coordinatorAction = detectedBy === 'coordinator'

  let signedContract = false
  let paymentRow = false

  try {
    const { data } = await supabase
      .from('contracts')
      .select('id')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .eq('status', 'signed')
      .limit(1)
    signedContract = (data?.length ?? 0) > 0
  } catch (err) {
    console.warn('[lifecycle] signed-contract probe failed:', err)
  }

  try {
    const { data } = await supabase
      .from('budget_payments')
      .select('id')
      .eq('venue_id', venueId)
      .eq('wedding_id', weddingId)
      .limit(1)
    paymentRow = (data?.length ?? 0) > 0
  } catch (err) {
    console.warn('[lifecycle] payment-row probe failed:', err)
  }

  return { signedContract, paymentRow, coordinatorAction }
}

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
  /**
   * True when the signal was recorded as a PROPOSAL rather than applied
   * (2026-09-14 ingestion audit item 3). `weddings.status` was NOT
   * written. A `wedding_lifecycle_events` row with signal
   * `proposed:<signal>` and `status_to = null` holds the claim for a
   * coordinator to confirm.
   */
  proposed?: boolean
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
  // Booking signals need non-text evidence before they may write status.
  // Only probe for the two signals that can produce it — every other
  // signal skips two DB reads it would never use.
  const corroboration = BOOKING_SIGNALS.has(signal)
    ? await loadBookingCorroboration(supabase, venueId, weddingId, detectedBy)
    : null

  const decision = nextStatus(currentStatus, signal, { corroboration })

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
        await writeOrLog(supabase.from('wedding_lifecycle_events').insert({
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
        }), { op: 'wedding_lifecycle_events.insert', venueId })
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

  const reason = args.reason ?? decision.reason

  // 2026-09-14 ingestion audit item 3. The engine says this WOULD be a
  // booking, but nothing outside the message text backs it up. Record
  // the claim and leave `weddings.status` alone. The event row carries
  // the `proposed:` prefix and a null `status_to`, which is the same
  // shape the violation path already uses, so the coordinator's audit
  // feed picks it up with no new surface.
  if (decision.requiresCorroboration) {
    const detail = corroboration
      ? `no signed contract, no payment row, not a coordinator action`
      : 'no corroboration loaded'
    try {
      await writeOrLog(supabase.from('wedding_lifecycle_events').insert({
        venue_id: venueId,
        wedding_id: weddingId,
        signal: 'proposed:' + signal,
        status_from: currentStatus,
        status_to: null,
        reason: `${reason} (proposed from message text only — ${detail}; confirm to apply)`,
        detected_by: detectedBy,
        source_interaction_id: args.sourceInteractionId ?? null,
        confidence: args.confidence ?? null,
      }), { op: 'wedding_lifecycle_events.insert', venueId })
    } catch (err) {
      console.warn('[lifecycle] booking proposal log failed:', err)
    }
    return {
      applied: false,
      from: currentStatus,
      to: null,
      reason: `booking proposed, awaiting corroboration (${reason})`,
      violation: false,
      proposed: true,
    }
  }

  // Legal transition. UPDATE + INSERT in parallel -- they don't depend
  // on each other.
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
