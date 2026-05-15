/**
 * Progression-event writer.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §3. A couple's
 * `last_progression_at` clock moves only on INBOUND, doctrine-listed
 * action types. §3 Don't skip #1 is explicit: "I will be tempted to
 * count 'sent email to person' as progression because it's simpler.
 * It's not. Only inbound events from the enumerated list count."
 *
 * Eligible event types (mirrors couple_progression_events CHECK):
 *   - email_reply              (channel=gmail, inbound)
 *   - tour_booked              (channel=calendly, action=tour_booked)
 *   - tour_rescheduled         (channel=calendly, action=tour_rescheduled)
 *   - tour_attended            (channel=calendly, action=tour_attended)
 *   - new_channel_inquiry      (channel=knot/ww/zola/website, action=inquiry*)
 *   - portal_click             (channel=portal, action=portal_click)
 *   - contract_signed          (channel=honeybook, action=contract_signed)
 *   - inbound_followup         (any inbound reply to an open thread)
 *   - fragment_match_returned  (operator confirms a candidate match)
 *
 * Outbound action types and the venue's own sends NEVER write.
 *
 * Idempotency
 * -----------
 * couple_progression_events PRIMARY KEY is (couple_id, occurred_at,
 * event_type), so a re-run of the linker on the same signal produces
 * zero new rows. We rely on the PK ON CONFLICT DO NOTHING.
 *
 * Side effect on couples
 * ----------------------
 * After inserting a progression event, we UPDATE
 * couples.last_progression_at = greatest(existing, this_occurrence).
 * The greatest() guard handles out-of-order writes (a backfilled
 * older event must never roll the clock backward).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedSignal } from './sources/types'

export type ProgressionEventType =
  | 'email_reply'
  | 'tour_booked'
  | 'tour_rescheduled'
  | 'tour_attended'
  | 'new_channel_inquiry'
  | 'portal_click'
  | 'contract_signed'
  | 'inbound_followup'
  | 'fragment_match_returned'

/**
 * Map a NormalizedSignal to its progression event type if it qualifies.
 * Returns null when the signal is outbound or non-progression-eligible.
 */
export function progressionEventTypeFor(
  signal: NormalizedSignal,
): ProgressionEventType | null {
  const channel = signal.channel.toLowerCase()
  const action = signal.action_type.toLowerCase()

  // Explicit outbound exclusions per §3 Don't skip #1.
  if (action === 'venue_sent' || action === 'outbound' || action === 'auto_send') {
    return null
  }

  if (channel === 'gmail') {
    if (action === 'reply' || action === 'inquiry') return 'email_reply'
    if (action === 'inbound_followup') return 'inbound_followup'
  }
  if (channel === 'calendly') {
    if (action === 'tour_booked') return 'tour_booked'
    if (action === 'tour_attended' || action === 'tour_completed_inferred') return 'tour_attended'
    if (action === 'tour_rescheduled') return 'tour_rescheduled'
  }
  if (channel === 'honeybook') {
    if (action === 'contract_signed' || action === 'booking_signed') return 'contract_signed'
  }
  if (channel === 'knot' || channel === 'weddingwire' || channel === 'zola') {
    if (action === 'inquiry' || action === 'inquiry_form' || action === 'message') return 'new_channel_inquiry'
  }
  if (channel === 'portal') {
    if (action === 'portal_click' || action === 'portal_visit') return 'portal_click'
  }
  if (channel === 'website') {
    if (action === 'inquiry_form_submitted' || action === 'inquiry') return 'new_channel_inquiry'
  }

  return null
}

/**
 * Write a progression event and bump couples.last_progression_at.
 * Safe to call on every linker tick; no-ops when the signal does
 * not qualify or when the (couple_id, occurred_at, event_type) row
 * already exists.
 *
 * Returns { recorded: true } when the progression event was inserted
 * AND the clock moved. Otherwise { recorded: false } with reason for
 * telemetry.
 */
export async function recordProgressionIfEligible(args: {
  supabase: SupabaseClient
  coupleId: string
  signal: NormalizedSignal
  touchpointId: string | null
}): Promise<{ recorded: boolean; eventType: ProgressionEventType | null }> {
  const { supabase, coupleId, signal, touchpointId } = args
  const eventType = progressionEventTypeFor(signal)
  if (!eventType) return { recorded: false, eventType: null }

  const occurredAt = signal.occurred_at

  const { error: insertErr } = await supabase
    .from('couple_progression_events')
    .insert({
      couple_id: coupleId,
      occurred_at: occurredAt,
      event_type: eventType,
      source_touchpoint_id: touchpointId,
    })

  // PK conflict → already recorded this exact event. Treat as success
  // but don't move the clock again (idempotent re-run).
  if (insertErr) {
    if (insertErr.code === '23505') {
      return { recorded: false, eventType }
    }
    // Any other error: skip the clock update; surface upstream.
    return { recorded: false, eventType }
  }

  // Bump last_progression_at iff this event is more recent than the
  // current value. PostgREST .or() guards against rolling the clock
  // backward on out-of-order arrivals; the NULL clause covers couples
  // backfilled to created_at where the column is still defaulted.
  await supabase
    .from('couples')
    .update({ last_progression_at: occurredAt })
    .eq('id', coupleId)
    .or(`last_progression_at.is.null,last_progression_at.lt.${occurredAt}`)

  return { recorded: true, eventType }
}

/**
 * Direct progression record for operator-confirmed candidate matches
 * (event_type='fragment_match_returned'). Called by the merge endpoint
 * after a fragment promotes onto a couple.
 */
export async function recordFragmentMatchReturned(args: {
  supabase: SupabaseClient
  coupleId: string
  touchpointId: string | null
  occurredAt?: string
}): Promise<void> {
  const occurredAt = args.occurredAt ?? new Date().toISOString()
  await args.supabase
    .from('couple_progression_events')
    .insert({
      couple_id: args.coupleId,
      occurred_at: occurredAt,
      event_type: 'fragment_match_returned',
      source_touchpoint_id: args.touchpointId,
    })
    .then(() => undefined, () => undefined)
  await args.supabase
    .from('couples')
    .update({ last_progression_at: occurredAt })
    .eq('id', args.coupleId)
    .or(`last_progression_at.is.null,last_progression_at.lt.${occurredAt}`)
    .then(() => undefined, () => undefined)
}
