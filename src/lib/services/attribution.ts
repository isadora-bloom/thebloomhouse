/**
 * Source attribution — multi-touch model on top of wedding_touchpoints.
 *
 * Phase 1 made wedding_touchpoints a complete journey log: every funnel
 * step a couple takes is recorded with its own source/medium. Phase 2
 * (this file) reads that log and rolls it up by source × funnel step,
 * applying a chosen attribution model so the user can answer:
 *
 *   "When Knot brings me a lead but they tour and book on Calendly,
 *    which channel gets the credit?"
 *
 * Three models supported:
 *   - first_touch — DEFAULT. The wedding's originating source gets
 *     credit for every funnel step that wedding reaches. Says "Knot
 *     started this lead, Knot owns the booking." Best when you spend
 *     to acquire leads and downstream channels are pure plumbing
 *     (Calendly, your own website forms).
 *   - last_touch — The source of the wedding's most recent funnel
 *     touchpoint before each step gets credit. Says "Calendly closed
 *     this lead." Useful when downstream channels actually drive
 *     conversion (e.g. paid retargeting).
 *   - linear — Every source the wedding touched gets equal credit
 *     (1/N) for every step. Useful when you can't pick first or last
 *     in good conscience.
 *
 * Multi-venue safe: takes a venueId and only reads that venue's data.
 * Demo-safe: caller decides which venues to query.
 *
 * Returns ZERO-spend for marketing_spend rollup; cost-per-X derivation
 * is layered on by the caller (the page already has spend) so this
 * service stays pure.
 */

import { createServiceClient } from '@/lib/supabase/service'

export type AttributionModel = 'first_touch' | 'last_touch' | 'linear'

export interface SourceFunnelRow {
  source: string | null
  inquiries: number
  tours_booked: number
  tours_conducted: number
  proposals_sent: number
  bookings: number
  revenue: number
  inquiry_to_tour_rate: number
  tour_to_booking_rate: number
  inquiry_to_booking_rate: number
}

interface ComputeOptions {
  model?: AttributionModel
  /** Inclusive lower bound on touchpoint occurred_at (ISO). Filters
   *  the wedding cohort to ones whose inquiry occurred at/after this. */
  from?: string
  /** Exclusive upper bound on touchpoint occurred_at (ISO). */
  to?: string
}

interface TouchpointRow {
  wedding_id: string
  source: string | null
  occurred_at: string
  touch_type: string
}

interface WeddingRow {
  id: string
  source: string | null
  status: string | null
  booking_value: number | null
  inquiry_date: string | null
}

/**
 * The set of touchpoint types that count as "this couple toured" /
 * "this couple booked". calendly_booked is grouped with tour_booked —
 * scheduling-tool bookings are tour bookings, just on a different
 * channel.
 */
const STEP_TOUCH_TYPES = {
  tour_booked: new Set(['tour_booked', 'calendly_booked']),
  tour_conducted: new Set(['tour_conducted']),
  proposal_sent: new Set(['proposal_sent']),
  contract_signed: new Set(['contract_signed']),
} as const

/**
 * Empty funnel cell — used as a base when accumulating.
 */
function emptyAgg() {
  return { inquiries: 0, tours_booked: 0, tours_conducted: 0, proposals_sent: 0, bookings: 0, revenue: 0 }
}

export async function computeSourceFunnel(
  venueId: string,
  options: ComputeOptions = {}
): Promise<SourceFunnelRow[]> {
  const sb = createServiceClient()
  const model = options.model ?? 'first_touch'

  // ---- Fetch every wedding for this venue ----
  // We need the wedding row to know status, booking_value, and
  // first-touch source. We always fetch every wedding for the venue
  // (date filter applies to touchpoints, not wedding rows).
  const { data: weddings } = await sb
    .from('weddings')
    .select('id, source, status, booking_value, inquiry_date')
    .eq('venue_id', venueId)
  const wedRows = (weddings ?? []) as WeddingRow[]
  const wedById = new Map<string, WeddingRow>()
  for (const w of wedRows) wedById.set(w.id, w)

  // ---- Fetch every touchpoint for this venue ----
  // The wedding cohort is filtered post-fetch by inquiry date if a
  // window was specified.
  let tpQuery = sb
    .from('wedding_touchpoints')
    .select('wedding_id, source, occurred_at, touch_type')
    .eq('venue_id', venueId)
    .order('occurred_at', { ascending: true })
  if (options.from) tpQuery = tpQuery.gte('occurred_at', options.from)
  if (options.to) tpQuery = tpQuery.lt('occurred_at', options.to)
  const { data: tps } = await tpQuery
  const tpRows = (tps ?? []) as TouchpointRow[]

  // Group touchpoints by wedding for cheap lookup.
  const tpByWedding = new Map<string, TouchpointRow[]>()
  for (const t of tpRows) {
    const arr = tpByWedding.get(t.wedding_id) ?? []
    arr.push(t)
    tpByWedding.set(t.wedding_id, arr)
  }

  // ---- Build per-wedding step indicators ----
  // For each wedding, decide whether it reached each funnel step and
  // which sources to credit.
  type Indicator = {
    inquiry: boolean
    tour_booked: boolean
    tour_conducted: boolean
    proposal_sent: boolean
    booked: boolean
    revenue: number
    creditedSources: Map<string | null, number>
  }
  const perWedding = new Map<string, Indicator>()

  for (const w of wedRows) {
    const tps = tpByWedding.get(w.id) ?? []
    if (tps.length === 0) continue // wedding has no touchpoints; skip

    // Cumulative funnel: each step rolls down from later steps. A
    // wedding that booked is counted at every step preceding it, even
    // if the explicit touchpoint for that step is missing — which
    // happens for historical data where the Calendly backfill wrote
    // only tour_conducted, not the matching tour_booked. This makes
    // the funnel monotonically non-increasing the way users expect to
    // read it.
    const rawProposal = tps.some((t) => STEP_TOUCH_TYPES.proposal_sent.has(t.touch_type))
    const rawTourConducted = tps.some((t) => STEP_TOUCH_TYPES.tour_conducted.has(t.touch_type))
    const rawTourBooked = tps.some((t) => STEP_TOUCH_TYPES.tour_booked.has(t.touch_type))
    const booked = tps.some((t) => STEP_TOUCH_TYPES.contract_signed.has(t.touch_type))
    const proposal_sent = rawProposal || booked
    const tour_conducted = rawTourConducted || proposal_sent
    const tour_booked = rawTourBooked || tour_conducted
    const ind: Indicator = {
      inquiry: tps.some((t) => t.touch_type === 'inquiry'),
      tour_booked,
      tour_conducted,
      proposal_sent,
      booked,
      revenue: 0,
      creditedSources: new Map<string | null, number>(),
    }
    if (ind.booked) ind.revenue = Number(w.booking_value ?? 0)

    // Source credit is model-dependent. Use weddings.source as the
    // canonical first-touch (it's normalized by email-pipeline at
    // wedding-creation time, single source of truth) and the
    // touchpoint's source field for last-touch / linear.
    if (model === 'first_touch') {
      ind.creditedSources.set(w.source ?? null, 1)
    } else if (model === 'last_touch') {
      // The latest touchpoint before booking — or the latest overall if
      // not booked yet. tps is occurred_at ASC.
      const lastBeforeBooking = ind.booked
        ? [...tps].reverse().find((t) => !STEP_TOUCH_TYPES.contract_signed.has(t.touch_type))
        : tps[tps.length - 1]
      ind.creditedSources.set(lastBeforeBooking?.source ?? w.source ?? null, 1)
    } else if (model === 'linear') {
      // Distinct sources across the journey, equal weight.
      const sources = new Set<string | null>()
      for (const t of tps) sources.add(t.source ?? null)
      // Always include the wedding's first-touch even if it isn't on a
      // touchpoint (rare but possible after merges).
      sources.add(w.source ?? null)
      const weight = 1 / sources.size
      for (const s of sources) ind.creditedSources.set(s, weight)
    }

    perWedding.set(w.id, ind)
  }

  // ---- Accumulate by credited source ----
  const bySource = new Map<string, ReturnType<typeof emptyAgg>>()
  for (const ind of perWedding.values()) {
    for (const [src, weight] of ind.creditedSources) {
      const key = src ?? '(unknown)'
      const agg = bySource.get(key) ?? emptyAgg()
      if (ind.inquiry) agg.inquiries += weight
      if (ind.tour_booked) agg.tours_booked += weight
      if (ind.tour_conducted) agg.tours_conducted += weight
      if (ind.proposal_sent) agg.proposals_sent += weight
      if (ind.booked) {
        agg.bookings += weight
        agg.revenue += ind.revenue * weight
      }
      bySource.set(key, agg)
    }
  }

  // ---- Shape into rows + derive conversion rates ----
  const rows: SourceFunnelRow[] = []
  for (const [src, agg] of bySource) {
    rows.push({
      source: src === '(unknown)' ? null : src,
      inquiries: round2(agg.inquiries),
      tours_booked: round2(agg.tours_booked),
      tours_conducted: round2(agg.tours_conducted),
      proposals_sent: round2(agg.proposals_sent),
      bookings: round2(agg.bookings),
      revenue: Math.round(agg.revenue),
      inquiry_to_tour_rate: agg.inquiries > 0 ? agg.tours_booked / agg.inquiries : 0,
      tour_to_booking_rate: agg.tours_booked > 0 ? agg.bookings / agg.tours_booked : 0,
      inquiry_to_booking_rate: agg.inquiries > 0 ? agg.bookings / agg.inquiries : 0,
    })
  }
  rows.sort((a, b) => b.inquiries - a.inquiries)
  return rows
}

/**
 * Linear attribution can produce fractional counts; round to 2dp so
 * the UI shows clean numbers without losing measurable precision.
 * First-touch / last-touch always produce integers, so this is a no-op
 * for those.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}
