/**
 * D9 — touchpoint direction.
 *
 * `touchpoints` has no direction column (Appendix C §C.4 flagged this
 * gap). Direction is derivable and this is the single place it is
 * derived, so the funnel / response-time / curve modules never each
 * re-invent the rule.
 *
 * The Gmail adapter (sources/gmail.ts) is the only adapter that emits
 * venue-side communication: action_type 'venue_sent' for outbound,
 * 'reply' for inbound. It also stamps raw_payload.direction. Every
 * other channel's touchpoints are couple-originated signals (tour
 * bookings, channel saves, reviews) — none are venue outbound.
 */

import type { TouchpointRow } from './types'

/** True when the touchpoint is a venue-originated (outbound) action. */
export function isOutbound(tp: TouchpointRow): boolean {
  if (tp.action_type === 'venue_sent') return true
  const raw = tp.raw_payload
  if (raw && typeof raw.direction === 'string') {
    return raw.direction.toLowerCase() === 'outbound'
  }
  return false
}

/** True when the touchpoint is an inbound signal (couple-originated). */
export function isInbound(tp: TouchpointRow): boolean {
  return !isOutbound(tp)
}

export function direction(tp: TouchpointRow): 'inbound' | 'outbound' {
  return isOutbound(tp) ? 'outbound' : 'inbound'
}

/** Action types that represent a tour being booked / scheduled. */
export const TOUR_BOOKED_ACTIONS = new Set([
  'tour_booked',
  'tour_rescheduled',
])

/** Action types that represent a tour the couple actually attended. */
export const TOUR_ATTENDED_ACTIONS = new Set(['tour_attended'])

/** Action types that represent a tour the couple failed to attend. */
export const TOUR_NO_SHOW_ACTIONS = new Set(['tour_no_show', 'tour_cancelled'])

/** Any tour-related action (booked, attended, or missed). */
export function isTourAction(actionType: string): boolean {
  return (
    TOUR_BOOKED_ACTIONS.has(actionType) ||
    TOUR_ATTENDED_ACTIONS.has(actionType) ||
    TOUR_NO_SHOW_ACTIONS.has(actionType)
  )
}
