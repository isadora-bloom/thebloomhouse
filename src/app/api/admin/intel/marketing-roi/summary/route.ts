/**
 * Wave 6B — marketing ROI top-line summary endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * GET query:
 *   { venueId?, windowDays? }
 *
 * Returns top-line numbers + biggest disparities (the leverage points
 * Wave 6C will turn into reallocation recommendations).
 *
 *   {
 *     ok: true,
 *     venueId,
 *     window: { days, start, end },
 *     totals: {
 *       spend_cents, inquiries, booked, conversion_pct, blended_cac_cents,
 *       blended_roi_pct, total_booked_value_cents,
 *     },
 *     topChannelsBySpend: [{ channel, spend_cents, share_pct }],
 *     topPersonasBySize: [{ persona_label, inquiries }],
 *     biggestDisparities: [{ channel, persona_label, roi_pct,
 *                            channel_avg_roi_pct, ratio, kind }],
 *     lastComputedAt,
 *   }
 *
 * "Biggest disparity" definition: cells where ROI deviates from the
 * channel-average by > 2x (or < 0.5x) AND the cell has n_too_small=false.
 * These are the leverage points — channels where one persona dominates
 * the revenue while another hides as a money sink.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

export const maxDuration = 30

interface AuthContext {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  bodyVenueId: string | null,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!bodyVenueId) {
      return badRequest('CRON_SECRET path requires venueId query param')
    }
    return { ctx: { isCron: true, venueId: bodyVenueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot read marketing ROI summary')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

interface RollupRow {
  channel: string
  persona_label: string | null
  time_window_start: string
  time_window_end: string
  spend_cents: number
  inquiries_count: number
  booked_count: number
  total_booked_value_cents: number
  cac_cents: number | null
  conversion_pct: number | null
  roi_pct: number | null
  n_too_small: boolean
  computed_at: string
}

const DISPARITY_HIGH_RATIO = 2.0
const DISPARITY_LOW_RATIO = 0.5

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const windowDaysRaw = url.searchParams.get('windowDays')
  const windowDays =
    windowDaysRaw && Number.isFinite(Number(windowDaysRaw))
      ? Math.max(1, Math.min(1000, Math.floor(Number(windowDaysRaw))))
      : 90

  const authResolved = await resolveAuth(req, venueIdParam)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from('persona_channel_rollups')
    .select(
      'channel, persona_label, time_window_start, time_window_end, spend_cents, inquiries_count, booked_count, total_booked_value_cents, cac_cents, conversion_pct, roi_pct, n_too_small, computed_at',
    )
    .eq('venue_id', venueId)
    .order('computed_at', { ascending: false })
    .limit(2000)

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }

  const allRows = (data ?? []) as RollupRow[]
  const windowMatches = allRows.filter((r) => {
    const startMs = Date.parse(r.time_window_start)
    const endMs = Date.parse(r.time_window_end)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false
    const lenDays = Math.round((endMs - startMs) / 86_400_000)
    return Math.abs(lenDays - windowDays) <= 1
  })

  if (windowMatches.length === 0) {
    return NextResponse.json({
      ok: true,
      venueId,
      window: { days: windowDays, start: null, end: null },
      totals: {
        spend_cents: 0,
        inquiries: 0,
        booked: 0,
        conversion_pct: null,
        blended_cac_cents: null,
        blended_roi_pct: null,
        total_booked_value_cents: 0,
      },
      topChannelsBySpend: [],
      topPersonasBySize: [],
      biggestDisparities: [],
      lastComputedAt: null,
      empty: true,
    })
  }

  const sorted = [...windowMatches].sort(
    (a, b) => Date.parse(b.computed_at) - Date.parse(a.computed_at),
  )
  const latestComputedAt = sorted[0].computed_at
  const latestStart = sorted[0].time_window_start
  const latestEnd = sorted[0].time_window_end

  const cells = sorted.filter(
    (r) =>
      r.computed_at === latestComputedAt &&
      r.time_window_start === latestStart &&
      r.time_window_end === latestEnd,
  )

  // Top-line totals.
  let totalSpend = 0
  let totalInquiries = 0
  let totalBooked = 0
  let totalBookedValue = 0
  for (const c of cells) {
    totalSpend += c.spend_cents
    totalInquiries += c.inquiries_count
    totalBooked += c.booked_count
    totalBookedValue += c.total_booked_value_cents
  }

  const blendedCacCents =
    totalBooked > 0 ? Math.round(totalSpend / totalBooked) : null
  const blendedConversionPct =
    totalInquiries > 0
      ? Math.round((totalBooked / totalInquiries) * 100 * 100) / 100
      : null
  const blendedRoiPct =
    totalSpend > 0
      ? Math.round(((totalBookedValue - totalSpend) / totalSpend) * 100 * 100) /
        100
      : null

  // Top channels by spend.
  const channelTotals = new Map<string, number>()
  for (const c of cells) {
    channelTotals.set(
      c.channel,
      (channelTotals.get(c.channel) ?? 0) + c.spend_cents,
    )
  }
  const topChannelsBySpend = Array.from(channelTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([channel, cents]) => ({
      channel,
      spend_cents: cents,
      share_pct:
        totalSpend > 0 ? Math.round((cents / totalSpend) * 100 * 100) / 100 : 0,
    }))

  // Top personas by cohort size.
  const personaSizes = new Map<string, number>()
  for (const c of cells) {
    if (c.persona_label) {
      personaSizes.set(
        c.persona_label,
        (personaSizes.get(c.persona_label) ?? 0) + c.inquiries_count,
      )
    }
  }
  const topPersonasBySize = Array.from(personaSizes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([persona_label, inquiries]) => ({ persona_label, inquiries }))

  // Biggest disparities: cells whose ROI deviates significantly from
  // the channel average. Both directions matter — over-performers
  // become "double down", under-performers become "redirect spend".
  // Channel avg only over n_too_small=false cells with non-null ROI.
  const channelRoiAvg = new Map<string, { sum: number; count: number }>()
  for (const c of cells) {
    if (c.n_too_small || c.roi_pct === null) continue
    const acc = channelRoiAvg.get(c.channel) ?? { sum: 0, count: 0 }
    acc.sum += c.roi_pct
    acc.count += 1
    channelRoiAvg.set(c.channel, acc)
  }

  const disparities: Array<{
    channel: string
    persona_label: string
    roi_pct: number
    channel_avg_roi_pct: number
    ratio: number
    spend_cents: number
    booked_count: number
    kind: 'over' | 'under'
  }> = []

  for (const c of cells) {
    if (c.n_too_small || c.roi_pct === null || !c.persona_label) continue
    const avg = channelRoiAvg.get(c.channel)
    if (!avg || avg.count < 2) continue // need at least two cells in channel to compare
    const channelAvg = avg.sum / avg.count
    if (channelAvg === 0) continue
    // Use absolute-magnitude ratio to handle negative ROI. Translate to
    // "how many times the channel-average is this cell?" — a cell with
    // ROI 50% in a channel averaging 200% has ratio 0.25 (under-performer);
    // a cell with ROI 400% in the same channel has ratio 2.0 (over-performer).
    const ratio = c.roi_pct / channelAvg
    const isOver = ratio >= DISPARITY_HIGH_RATIO
    const isUnder = ratio > 0 && ratio <= DISPARITY_LOW_RATIO
    if (!isOver && !isUnder) continue
    disparities.push({
      channel: c.channel,
      persona_label: c.persona_label,
      roi_pct: c.roi_pct,
      channel_avg_roi_pct: Math.round(channelAvg * 100) / 100,
      ratio: Math.round(ratio * 1000) / 1000,
      spend_cents: c.spend_cents,
      booked_count: c.booked_count,
      kind: isOver ? 'over' : 'under',
    })
  }
  // Sort disparities by spend size — leverage = "how much of my budget
  // is in this off-pattern cell". Operator's eye should land on the
  // biggest-spend deviations first.
  disparities.sort((a, b) => b.spend_cents - a.spend_cents)
  const biggestDisparities = disparities.slice(0, 5)

  return NextResponse.json({
    ok: true,
    venueId,
    window: {
      days: windowDays,
      start: latestStart,
      end: latestEnd,
    },
    totals: {
      spend_cents: totalSpend,
      inquiries: totalInquiries,
      booked: totalBooked,
      conversion_pct: blendedConversionPct,
      blended_cac_cents: blendedCacCents,
      blended_roi_pct: blendedRoiPct,
      total_booked_value_cents: totalBookedValue,
    },
    topChannelsBySpend,
    topPersonasBySize,
    biggestDisparities,
    lastComputedAt: latestComputedAt,
    empty: false,
  })
}
