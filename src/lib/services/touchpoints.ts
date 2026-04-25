/**
 * Wedding touchpoints — multi-touch journey writes.
 *
 * Every meaningful state change on a lead's journey writes a row to
 * wedding_touchpoints. Together those rows ARE the journey: chronological,
 * append-only, per (venue, wedding). Migration 079 created the table and
 * back-filled one inquiry row per existing wedding; 093 extended the
 * touch_type enum to cover the full funnel through contract_signed.
 *
 * Why a separate service:
 *   - Single dedup contract — same touch_type at the same occurred_at
 *     on the same wedding never inserts twice. Lets every caller (email
 *     pipeline, signal inference, scheduling-tool path, backfill scripts)
 *     fire-and-forget without coordinating with each other.
 *   - Single mapping from engagement_event types → touch_type. Keeps
 *     the funnel definition in one place so /intel/sources can rely on
 *     it.
 *   - White-label by design — only takes (venueId, weddingId) and the
 *     event details; no venue-specific logic.
 *
 * Does NOT update weddings.source. That column stays first-touch-only;
 * the touchpoints table is the multi-touch system of record.
 */

import { createServiceClient } from '@/lib/supabase/service'

export type TouchType =
  | 'inquiry'
  | 'email_reply'
  | 'tour_booked'
  | 'tour_conducted'
  | 'proposal_sent'
  | 'contract_signed'
  | 'website_visit'
  | 'ad_click'
  | 'referral'
  | 'calendly_booked'
  | 'other'

export interface TouchpointInput {
  venueId: string
  weddingId: string
  touchType: TouchType
  /** Source channel — e.g. 'the_knot', 'calendly', 'instagram'. Should be
   *  a canonical value from CANONICAL_SOURCES; non-canonical strings are
   *  accepted but won't group correctly in /intel/sources. */
  source?: string | null
  /** Channel medium — 'email', 'webhook', 'website', 'phone'. */
  medium?: string | null
  /** Free text — e.g. 'spring_2026_promo', UTM campaign id. */
  campaign?: string | null
  /** When the touch actually happened (email date, webhook event time,
   *  tour datetime). Falls back to now() at the DB level if omitted. */
  occurredAt?: string
  /** Audit trail — interaction_id that produced this touchpoint, the
   *  scheduling_kind from a Calendly event, etc. */
  metadata?: Record<string, unknown>
}

/**
 * Touch types that can only happen ONCE per wedding by definition.
 * 'inquiry' is the moment they first reached out — there's exactly one
 * even if multiple ingest paths write it. 'contract_signed' is the
 * booking moment — exactly one. Dedup keys on touch_type alone for
 * these (any existing row blocks the insert), regardless of occurred_at.
 *
 * 'proposal_sent' is excluded because some venues send multiple
 * versions of a contract before the couple signs; each is a real event.
 * 'tour_booked' / 'tour_conducted' / 'email_reply' fire multiple times
 * legitimately and dedup by exact (type, time).
 */
const ONE_PER_WEDDING_TOUCH_TYPES = new Set<TouchType>(['inquiry', 'contract_signed'])

/**
 * Fire one touchpoint. Idempotent on two layers:
 *   1. ONE_PER_WEDDING_TOUCH_TYPES: skip if any row of this touch_type
 *      already exists on the wedding. Inquiry / contract_signed mark
 *      moments that can only happen once even if multiple writers
 *      report them with slightly different timestamps.
 *   2. Other types: skip if a row with the same (wedding_id, touch_type,
 *      occurred_at) already exists. Allows legitimate repeats (multiple
 *      replies, tours rescheduled then attended) while preventing
 *      backfill-pass-2 from duplicating.
 */
export async function recordTouchpoint(input: TouchpointInput): Promise<void> {
  const sb = createServiceClient()

  if (ONE_PER_WEDDING_TOUCH_TYPES.has(input.touchType)) {
    const { data: existing } = await sb
      .from('wedding_touchpoints')
      .select('id')
      .eq('wedding_id', input.weddingId)
      .eq('touch_type', input.touchType)
      .limit(1)
    if (existing && existing.length > 0) return
  } else if (input.occurredAt) {
    const { data: existing } = await sb
      .from('wedding_touchpoints')
      .select('id')
      .eq('wedding_id', input.weddingId)
      .eq('touch_type', input.touchType)
      .eq('occurred_at', input.occurredAt)
      .limit(1)
    if (existing && existing.length > 0) return
  }

  const row: Record<string, unknown> = {
    venue_id: input.venueId,
    wedding_id: input.weddingId,
    touch_type: input.touchType,
    source: input.source ?? null,
    medium: input.medium ?? null,
    campaign: input.campaign ?? null,
    metadata: input.metadata ?? {},
  }
  if (input.occurredAt) row.occurred_at = input.occurredAt

  await sb.from('wedding_touchpoints').insert(row)
}

/**
 * Fire a status-change touchpoint when a wedding's status crosses into
 * a funnel-step value that wasn't explicitly fired by an
 * engagement event. Called from anywhere that updates weddings.status.
 *
 * Why this exists: a Calendly final_walkthrough event auto-promotes a
 * wedding to status='booked' but doesn't fire a contract_signed
 * engagement event (and shouldn't — it's a post-booking event, not a
 * booking event). Without this, /intel/sources sees the booking-status
 * in weddings but no contract_signed touchpoint, so the funnel-by-
 * source conversion drops to 0%. Status-change touchpoints close that
 * gap by guaranteeing the funnel has an entry whenever the wedding
 * actually reaches that funnel rung.
 *
 * 'inquiry' isn't in the mapping because that's owned by email-pipeline
 * at wedding-create time. tour_scheduled→tour_booked is owned by the
 * scheduling-event firing path. This function is the safety net for
 * proposal_sent + booked.
 */
const STATUS_TO_TOUCH_TYPE: Record<string, TouchType> = {
  proposal_sent: 'proposal_sent',
  booked: 'contract_signed',
}

export async function recordStatusChangeTouchpoint(
  venueId: string,
  weddingId: string,
  newStatus: string,
  options?: { source?: string | null; occurredAt?: string; medium?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  const tt = STATUS_TO_TOUCH_TYPE[newStatus]
  if (!tt) return
  await recordTouchpoint({
    venueId,
    weddingId,
    touchType: tt,
    source: options?.source ?? null,
    medium: options?.medium ?? 'status_change',
    occurredAt: options?.occurredAt,
    metadata: { from_status_change: newStatus, ...(options?.metadata ?? {}) },
  })
}

/**
 * Map an engagement_event type to its corresponding touch_type. Returns
 * null when the engagement event isn't attribution-relevant (heat-internal
 * signals like high_specificity / sustained_engagement / planning_meeting
 * shouldn't appear in the funnel — they don't represent a couple
 * progressing along it).
 */
export function engagementToTouchType(eventType: string, source?: string | null): TouchType | null {
  switch (eventType) {
    case 'initial_inquiry':       return 'inquiry'
    case 'email_reply_received':  return 'email_reply'
    case 'tour_requested':        return null // intent signal, not a step taken
    case 'tour_scheduled':
      // Calendly bookings deserve their own bucket so /intel/sources can
      // tell venue-form bookings (tour_booked) from scheduling-tool ones.
      return source === 'calendly' || source === 'acuity' ? 'calendly_booked' : 'tour_booked'
    case 'tour_completed':        return 'tour_conducted'
    case 'tour_rescheduled':      return null // re-scheduling isn't a new funnel step
    case 'tour_cancelled':        return null // would muddy a "did the tour happen" count
    case 'contract_sent':         return 'proposal_sent'
    case 'contract_signed':       return 'contract_signed'
    // Already-booked Calendly event types — not part of acquisition funnel
    case 'final_walkthrough':     return null
    case 'pre_wedding_event':     return null
    case 'planning_meeting':      return null
    // Heat-internal signals — never funnel
    case 'high_specificity':      return null
    case 'high_commitment_signal':return null
    case 'family_mentioned':      return null
    case 'sustained_engagement':  return null
    case 'marketing_metric':      return null
    default:                      return null
  }
}

/**
 * Batched touchpoint write keyed off engagement events. The pipeline
 * fires several engagement_events from a single email (e.g. tour
 * confirmation can fire tour_scheduled + email_reply_received); pass
 * them all here and we write only the attribution-relevant ones with
 * proper dedup.
 */
export async function recordTouchpointsForEngagementEvents(
  venueId: string,
  weddingId: string,
  events: Array<{ eventType: string; source?: string | null; occurredAt?: string; metadata?: Record<string, unknown> }>
): Promise<void> {
  for (const e of events) {
    const tt = engagementToTouchType(e.eventType, e.source ?? null)
    if (!tt) continue
    await recordTouchpoint({
      venueId,
      weddingId,
      touchType: tt,
      source: e.source ?? null,
      medium: 'email',
      occurredAt: e.occurredAt,
      metadata: { engagement_event_type: e.eventType, ...(e.metadata ?? {}) },
    })
  }
}
