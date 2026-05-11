/**
 * Wave 25 — force-recompute snapshot.
 *
 * POST /api/admin/intel/channels/[channelSlug]/recompute?venueId=X
 * body: { windowDays?: 30 | 90 | 365 }
 *
 * Re-derives the snapshot from live attribution_events and persists a
 * fresh row in channel_intel_snapshots.
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
import { computeChannelSnapshot } from '@/lib/services/channel-intel-hub/compute'
import { slugToPlatform } from '@/lib/services/channel-intel-hub/slugs'

export const maxDuration = 120

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ channelSlug: string }> },
) {
  const { channelSlug } = await params
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')

  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string
  if (cronAuth) {
    if (!requestedVenueId) return badRequest('CRON_SECRET path requires venueId query param')
    venueId = requestedVenueId
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    venueId = requestedVenueId ?? auth.venueId
    const decision = await assertCanAccessVenue(auth, venueId)
    if (!decision.ok) return forbidden(decision.reason)
  }

  let body: { windowDays?: number } = {}
  try {
    body = (await req.json()) as { windowDays?: number }
  } catch {
    body = {}
  }
  const windowDays = body.windowDays ?? 90
  if (![30, 90, 365].includes(windowDays)) {
    return badRequest('windowDays must be 30 / 90 / 365')
  }

  const sourcePlatform = slugToPlatform(channelSlug)
  try {
    const sb = createServiceClient()
    const snapshot = await computeChannelSnapshot({
      venueId,
      sourcePlatform,
      windowDays,
      persist: true,
      supabase: sb,
    })
    return NextResponse.json({ ok: true, snapshot })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[channels/${channelSlug}/recompute] error:`, message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
