/**
 * Wave 25 — channel-list comparison endpoint.
 *
 * GET /api/admin/intel/channels/list?venueId=X&windowDays=Y
 *
 * Returns one row per channel with >= 10 AE in the window, with the
 * mini story-arc + comparison numbers. Used by /intel/channels (the
 * comparison page).
 *
 * Auth: standard CRON_SECRET / coordinator pattern.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  assertCanAccessVenue,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  computeChannelSnapshot,
  listChannelsForVenue,
} from '@/lib/services/channel-intel-hub/compute'
import type {
  ChannelComparisonPayload,
  ChannelComparisonRow,
  StoryArcSegment,
} from '@/lib/services/channel-intel-hub/types'

export const maxDuration = 120

interface AuthCtx {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  requestedVenueId: string | null,
): Promise<{ ctx: AuthCtx } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!requestedVenueId) return badRequest('CRON_SECRET path requires venueId query param')
    return { ctx: { isCron: true, venueId: requestedVenueId } }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const venueId = requestedVenueId ?? auth.venueId
  const decision = await assertCanAccessVenue(auth, venueId)
  if (!decision.ok) return forbidden(decision.reason)
  return { ctx: { isCron: false, venueId } }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')
  const windowDaysRaw = url.searchParams.get('windowDays') ?? '90'
  const windowDays = parseInt(windowDaysRaw, 10)
  if (!Number.isFinite(windowDays) || ![30, 90, 365].includes(windowDays)) {
    return badRequest('windowDays must be 30 / 90 / 365')
  }

  const authResolved = await resolveAuth(req, requestedVenueId)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  try {
    const sb = createServiceClient()
    const channels = await listChannelsForVenue({ venueId, windowDays, supabase: sb, minAeCount: 10 })

    // Venue label
    let venueLabel = 'venue'
    const { data: venueRow } = await sb.from('venues').select('name').eq('id', venueId).maybeSingle()
    if (venueRow && typeof (venueRow as { name?: string }).name === 'string') {
      venueLabel = (venueRow as { name: string }).name
    }

    // Compute one snapshot per channel — parallel.
    const snapshots = await Promise.all(
      channels.map((c) =>
        computeChannelSnapshot({
          venueId,
          sourcePlatform: c.source_platform,
          windowDays,
          persist: false,
          supabase: sb,
        }),
      ),
    )

    const rows: ChannelComparisonRow[] = snapshots.map((s) => {
      const storyArcMini: Record<StoryArcSegment, number> = {
        discovery: 0,
        inquiry: 0,
        validation: 0,
        broadcast: 0,
        cross_platform_footprint: 0,
      }
      for (const cell of s.story_arc) storyArcMini[cell.segment] = cell.unique_weddings
      const apparentCac = s.cost_metrics.cac_cents
      const realCac = s.cost_metrics.cac_excluding_broadcast_and_crossplatform_cents
      const v1Pct =
        s.sample_sizes.ae_total > 0
          ? (s.confidence_signals.v1_contaminated_count / s.sample_sizes.ae_total) * 100
          : 0
      return {
        channel_slug: s.channel_slug,
        source_platform: s.source_platform,
        display_name: s.display_name,
        unique_weddings: s.sample_sizes.unique_weddings,
        ae_total: s.sample_sizes.ae_total,
        story_arc_mini: storyArcMini,
        funnel_inquiries: s.funnel.inquiries,
        funnel_booked: s.funnel.booked,
        conversion_rate_0_1: s.funnel.inquiry_to_booked_rate_0_1,
        apparent_cac_cents: apparentCac,
        real_cac_cents: realCac,
        cac_delta_cents:
          apparentCac !== null && realCac !== null ? realCac - apparentCac : null,
        avg_review_rating: s.quality_metrics.avg_review_rating,
        review_count: s.quality_metrics.review_count,
        data_freshness_iso: s.confidence_signals.data_freshness_iso,
        v1_contaminated_pct: v1Pct,
      }
    })

    const payload: ChannelComparisonPayload = {
      ok: true,
      venue_id: venueId,
      venue_label: venueLabel,
      window_days: windowDays,
      computed_at_iso: new Date().toISOString(),
      rows,
      total_channels_with_data: rows.length,
    }
    return NextResponse.json(payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[channels/list] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
