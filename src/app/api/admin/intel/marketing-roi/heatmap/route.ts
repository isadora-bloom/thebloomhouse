/**
 * Wave 6B — marketing ROI heatmap endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * GET query:
 *   { venueId?, windowDays? }
 *
 * Returns a structured heatmap:
 *   {
 *     ok: true,
 *     venueId,
 *     window: { days, start, end },
 *     personas: string[],   // rows, ordered by venue cohort size desc
 *     channels: string[],   // cols, ordered by spend desc
 *     cells: Array<{
 *       channel,
 *       persona_label,
 *       spend_cents,
 *       inquiries_count,
 *       booked_count,
 *       cac_cents | null,
 *       conversion_pct | null,
 *       roi_pct | null,
 *       n_too_small,
 *       label?  // 'n < 10' when suppressed
 *     }>,
 *     lastComputedAt,
 *   }
 *
 * Cells with n_too_small=true return numerics as null + label "n < 10"
 * so the UI cannot accidentally render a misleading percentage.
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
  if (auth.isDemo) return forbidden('demo cannot read marketing ROI heatmap')
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
  touring_count: number
  booked_count: number
  lost_count: number
  total_booked_value_cents: number
  cac_cents: number | null
  conversion_pct: number | null
  avg_booking_value_cents: number | null
  roi_pct: number | null
  payback_months: number | null
  n_too_small: boolean
  computed_at: string
}

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

  // Pull every cell whose window length matches windowDays. Multiple
  // (start, end) pairs may exist if the rollup ran on different days;
  // pick the most recent computed_at and read all cells from that
  // batch.
  const { data, error } = await supabase
    .from('persona_channel_rollups')
    .select(
      'channel, persona_label, time_window_start, time_window_end, spend_cents, inquiries_count, touring_count, booked_count, lost_count, total_booked_value_cents, cac_cents, conversion_pct, avg_booking_value_cents, roi_pct, payback_months, n_too_small, computed_at',
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

  // Filter to rows whose window length (end - start, days) matches the
  // requested windowDays. Tolerance ±1 day to absorb leap-day rounding.
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
      personas: [],
      channels: [],
      cells: [],
      lastComputedAt: null,
      empty: true,
    })
  }

  // Pick the most recent computed_at for this window.
  const sorted = [...windowMatches].sort(
    (a, b) => Date.parse(b.computed_at) - Date.parse(a.computed_at),
  )
  const latestComputedAt = sorted[0].computed_at
  const latestStart = sorted[0].time_window_start
  const latestEnd = sorted[0].time_window_end

  const cellsRaw = sorted.filter(
    (r) =>
      r.computed_at === latestComputedAt &&
      r.time_window_start === latestStart &&
      r.time_window_end === latestEnd,
  )

  // Order channels by spend desc.
  const channelTotals = new Map<string, number>()
  for (const c of cellsRaw) {
    channelTotals.set(
      c.channel,
      (channelTotals.get(c.channel) ?? 0) + (c.spend_cents || 0),
    )
  }
  const channels = Array.from(channelTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([ch]) => ch)

  // Order personas by cohort size (inquiries_count) desc. NULL persona
  // floats to the end so the heatmap reads "real personas first, then
  // un-tagged".
  const personaTotals = new Map<string, number>()
  let untaggedTotal = 0
  for (const c of cellsRaw) {
    if (c.persona_label) {
      personaTotals.set(
        c.persona_label,
        (personaTotals.get(c.persona_label) ?? 0) + (c.inquiries_count || 0),
      )
    } else {
      untaggedTotal += c.inquiries_count || 0
    }
  }
  const personas = Array.from(personaTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p)
  if (untaggedTotal > 0 || cellsRaw.some((c) => !c.persona_label)) {
    personas.push('__untagged__')
  }

  // Project the cells, applying n < 10 suppression.
  const cells = cellsRaw.map((c) => {
    const personaKey = c.persona_label ?? '__untagged__'
    return {
      channel: c.channel,
      persona_label: personaKey,
      spend_cents: c.spend_cents,
      inquiries_count: c.inquiries_count,
      booked_count: c.booked_count,
      total_booked_value_cents: c.total_booked_value_cents,
      cac_cents: c.n_too_small ? null : c.cac_cents,
      conversion_pct: c.n_too_small ? null : c.conversion_pct,
      roi_pct: c.n_too_small ? null : c.roi_pct,
      avg_booking_value_cents: c.avg_booking_value_cents,
      n_too_small: c.n_too_small,
      label: c.n_too_small ? 'n < 10' : null,
    }
  })

  return NextResponse.json({
    ok: true,
    venueId,
    window: {
      days: windowDays,
      start: latestStart,
      end: latestEnd,
    },
    personas,
    channels,
    cells,
    lastComputedAt: latestComputedAt,
    empty: false,
  })
}
