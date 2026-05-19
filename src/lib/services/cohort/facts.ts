/**
 * D9 — per-couple facts.
 *
 * One pass over the loaded spine produces a CoupleFacts row per engaged
 * couple. funnel / response-time / curve all consume this rather than
 * each re-scanning touchpoints — one scan, one definition of "toured",
 * one definition of "first reply".
 *
 * Scope: engaged couples only (lifecycle resolved / booked / ghost).
 * channel_scoped + agent rows never enter the funnel or the cohort
 * distributions (doctrine §C.2 — un-acknowledged signal is not a
 * couple-in-funnel).
 */

import type { CohortData, CoupleRow, TouchpointRow } from './types'
import { ENGAGED_STATES } from './types'
import { isOutbound, TOUR_ATTENDED_ACTIONS, TOUR_BOOKED_ACTIONS } from './direction'

const HOUR_MS = 3600_000

export interface CoupleFacts {
  couple: CoupleRow
  touchpoints: TouchpointRow[]
  /** Earliest touchpoint of any direction; falls back to created_at. */
  firstTouchAt: string
  /** Earliest inbound touchpoint — the inquiry arriving. */
  firstInboundAt: string | null
  /** Channel of the first inbound touchpoint. */
  arrivalChannel: string | null
  /** Hours from first inbound to first venue reply. null when the
   *  couple has an inbound but the venue never replied, or has no
   *  inbound at all. `hasReply` disambiguates the two. */
  responseHours: number | null
  hasInbound: boolean
  hasReply: boolean
  /** Furthest funnel stage reached, 1 (inquiry) .. 5 (booked). */
  furthest: number
  toured: boolean
  booked: boolean
  isGhost: boolean
  /** occurred_at of the tour (attended preferred, else booked). */
  tourAt: string | null
  outcome: 'booked' | 'ghost' | 'in_progress'
}

export function buildCoupleFacts(data: CohortData): CoupleFacts[] {
  // Index progression event types by couple.
  const progressionByCouple = new Map<string, Set<string>>()
  for (const ev of data.progression) {
    const set = progressionByCouple.get(ev.couple_id)
    if (set) set.add(ev.event_type)
    else progressionByCouple.set(ev.couple_id, new Set([ev.event_type]))
  }

  const engaged = data.couples.filter((c) =>
    (ENGAGED_STATES as readonly string[]).includes(c.lifecycle_state),
  )

  return engaged.map((couple) => {
    const tps = data.byCouple.get(couple.id) ?? [] // occurred_at ASC
    const progEvents = progressionByCouple.get(couple.id) ?? new Set<string>()

    let firstInbound: TouchpointRow | null = null
    let firstReply: TouchpointRow | null = null
    let hasTourBooked = false
    let hasToured = false
    let tourAt: string | null = null

    for (const tp of tps) {
      const outbound = isOutbound(tp)
      if (!outbound && !firstInbound) firstInbound = tp
      if (
        outbound &&
        !firstReply &&
        firstInbound &&
        Date.parse(tp.occurred_at) >= Date.parse(firstInbound.occurred_at)
      ) {
        firstReply = tp
      }
      if (TOUR_BOOKED_ACTIONS.has(tp.action_type)) {
        hasTourBooked = true
        if (!tourAt) tourAt = tp.occurred_at
      }
      if (TOUR_ATTENDED_ACTIONS.has(tp.action_type)) {
        hasToured = true
        tourAt = tp.occurred_at
      }
    }
    if (progEvents.has('tour_booked') || progEvents.has('tour_rescheduled'))
      hasTourBooked = true
    if (progEvents.has('tour_attended')) hasToured = true

    const hasOutbound = tps.some((tp) => isOutbound(tp))
    const booked = couple.lifecycle_state === 'booked'
    const isGhost = couple.lifecycle_state === 'ghost'

    let furthest = 1
    if (hasOutbound) furthest = Math.max(furthest, 2)
    if (hasTourBooked) furthest = Math.max(furthest, 3)
    if (hasToured) furthest = Math.max(furthest, 4)
    if (booked) furthest = 5 // booked implies every upstream stage

    let responseHours: number | null = null
    if (firstInbound && firstReply) {
      const gap =
        Date.parse(firstReply.occurred_at) -
        Date.parse(firstInbound.occurred_at)
      if (Number.isFinite(gap) && gap >= 0) responseHours = gap / HOUR_MS
    }

    return {
      couple,
      touchpoints: tps,
      firstTouchAt: tps.length > 0 ? tps[0].occurred_at : couple.created_at,
      firstInboundAt: firstInbound ? firstInbound.occurred_at : null,
      arrivalChannel: firstInbound ? firstInbound.channel : null,
      responseHours,
      hasInbound: firstInbound !== null,
      hasReply: firstReply !== null,
      furthest,
      toured: furthest >= 4,
      booked,
      isGhost,
      tourAt,
      outcome: booked ? 'booked' : isGhost ? 'ghost' : 'in_progress',
    }
  })
}
