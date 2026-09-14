/**
 * Month-over-month impact counts, off the spine.
 *
 * /intel/roi ("Your Impact") used to build these itself: inbound
 * `interactions` for inquiries, a hand-rolled inbound/outbound pairing
 * over `interactions` for response time, `weddings.booked_at` for
 * bookings and `weddings.booking_value` summed for pipeline. Four
 * derivations, none of them shared with any other page, so the same
 * question had a different answer on /intel/cohort and in Ask your data.
 *
 * What lives here is only the part the canonical six do not already
 * answer: two windowed event counts. Response time is NOT here. It
 * comes from `getCohortFunnel`, which is the reader that owns it, and
 * the pipeline count comes from `getVenueOverview`'s lifecycle
 * breakdown. One number, one function, on purpose.
 *
 * Honesty
 * -------
 * `touchpoints.direction` is stamped at write time by the forwards
 * linker (migration 381) and read-time inference is banned. Rows written
 * before that migration carry NULL, so they are NOT counted as inbound
 * and NOT guessed at. `unstampedThisMonth` reports how many were skipped
 * so the surface can say "we counted what we could see" instead of
 * quietly under-reporting.
 *
 * Injectable client, no service-role import, no network. Unit-tested in
 * ./__tests__/venue-impact.test.ts against the in-memory fake.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

/** Spine action types that mean a contract was signed. Mirrors the
 *  honeybook half of `INBOUND_ACTIONS` in canonical.ts, so "a booking"
 *  means the same event here as it does on the daily list. */
export const BOOKING_ACTION_TYPES = ['contract_signed', 'booking_signed'] as const

export interface ImpactCount {
  thisMonth: number
  lastMonth: number
}

export interface VenueImpact {
  /** Inbound touchpoints, this calendar month and the last complete one. */
  inquiries: ImpactCount
  /** Distinct couples with a contract-signed touchpoint in the window. */
  bookings: ImpactCount
  /** Touchpoints this month with no write-time direction stamp. Not
   *  counted as inbound, not guessed at, reported so the gap is visible. */
  unstampedThisMonth: number
  /** The window boundaries actually used, so a surface can print them. */
  window: { monthStart: string; lastMonthStart: string; lastMonthEnd: string }
  generatedAt: string
}

interface ImpactTouchpointRow {
  couple_id: string | null
  action_type: string
  direction: string | null
  occurred_at: string
}

function emptyImpact(window: VenueImpact['window'], generatedAt: string): VenueImpact {
  return {
    inquiries: { thisMonth: 0, lastMonth: 0 },
    bookings: { thisMonth: 0, lastMonth: 0 },
    unstampedThisMonth: 0,
    window,
    generatedAt,
  }
}

/** Calendar-month boundaries in the server's zone. The ROI page has
 *  always spoken in calendar months and operators read it that way. */
function monthWindow(now: Date) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1)
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999)
  return {
    monthStart: monthStart.toISOString(),
    lastMonthStart: lastMonthStart.toISOString(),
    lastMonthEnd: lastMonthEnd.toISOString(),
  }
}

/**
 * Spine-only impact counts. Reads `touchpoints`, venue-scoped, once,
 * for the two months the surface compares. Never reads the legacy
 * stacks.
 */
export async function loadVenueImpact(
  supabase: SupabaseClient,
  venueId: string,
  opts: { now?: Date } = {},
): Promise<VenueImpact> {
  const generatedAt = new Date().toISOString()
  const window = monthWindow(opts.now ?? new Date())
  if (!venueId) return emptyImpact(window, generatedAt)

  // One pull covering both months. The surface only ever shows this
  // month against last, so the bound is the start of last month.
  const { data } = await supabase
    .from('touchpoints')
    .select('couple_id, action_type, direction, occurred_at')
    .eq('venue_id', venueId)
    .gte('occurred_at', window.lastMonthStart)
    .order('occurred_at', { ascending: true })
    .limit(20000)

  const rows = (data ?? []) as ImpactTouchpointRow[]
  const bookingActions = new Set<string>(BOOKING_ACTION_TYPES)

  let inquiriesThis = 0
  let inquiriesLast = 0
  let unstampedThisMonth = 0
  const bookedThis = new Set<string>()
  const bookedLast = new Set<string>()

  for (const r of rows) {
    const at = r.occurred_at
    const isThisMonth = at >= window.monthStart
    const isLastMonth = !isThisMonth && at >= window.lastMonthStart && at <= window.lastMonthEnd
    if (!isThisMonth && !isLastMonth) continue

    if (r.direction === 'inbound') {
      if (isThisMonth) inquiriesThis++
      else inquiriesLast++
    } else if (r.direction === null || r.direction === undefined) {
      if (isThisMonth) unstampedThisMonth++
    }

    if (bookingActions.has(r.action_type) && r.couple_id) {
      if (isThisMonth) bookedThis.add(r.couple_id)
      else bookedLast.add(r.couple_id)
    }
  }

  return {
    inquiries: { thisMonth: inquiriesThis, lastMonth: inquiriesLast },
    bookings: { thisMonth: bookedThis.size, lastMonth: bookedLast.size },
    unstampedThisMonth,
    window,
    generatedAt,
  }
}
