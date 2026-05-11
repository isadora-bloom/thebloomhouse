/**
 * Wave 25 — per-source snapshot endpoint.
 *
 * GET /api/admin/intel/channels/[channelSlug]/snapshot?venueId=X&windowDays=Y
 *
 * Returns the ChannelSnapshot + narrator output for one channel.
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
import { narrateSourceStory } from '@/lib/services/channel-intel-hub/narrate-source'
import { slugToPlatform } from '@/lib/services/channel-intel-hub/slugs'
import type { PerSourcePayload } from '@/lib/services/channel-intel-hub/types'

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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ channelSlug: string }> },
) {
  const { channelSlug } = await params
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')
  const windowDaysRaw = url.searchParams.get('windowDays') ?? '90'
  const skipNarrator = url.searchParams.get('skipNarrator') === 'true'
  const windowDays = parseInt(windowDaysRaw, 10)
  if (!Number.isFinite(windowDays) || ![30, 90, 365].includes(windowDays)) {
    return badRequest('windowDays must be 30 / 90 / 365')
  }

  const authResolved = await resolveAuth(req, requestedVenueId)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const sourcePlatform = slugToPlatform(channelSlug)

  try {
    const sb = createServiceClient()
    const snapshot = await computeChannelSnapshot({
      venueId,
      sourcePlatform,
      windowDays,
      persist: false,
      supabase: sb,
    })

    // Venue label
    let venueLabel = 'venue'
    const { data: venueRow } = await sb.from('venues').select('name').eq('id', venueId).maybeSingle()
    if (venueRow && typeof (venueRow as { name?: string }).name === 'string') {
      venueLabel = (venueRow as { name: string }).name
    }

    // Disagreement findings (Wave 17) for this channel
    const { data: disagreements } = await sb
      .from('disagreement_findings')
      .select('id, axis, magnitude_score, stated_value, forensic_value, last_observed_at, status')
      .eq('venue_id', venueId)
      .eq('axis', 'crm_source')
      .eq('status', 'active')
      .order('magnitude_score', { ascending: false, nullsFirst: false })
      .limit(20)
    const channelDisagreements = (disagreements ?? []).filter((d) => {
      const sv = String(d.stated_value ?? '').toLowerCase()
      const fv = String(d.forensic_value ?? '').toLowerCase()
      return sv.includes(sourcePlatform.toLowerCase()) || fv.includes(sourcePlatform.toLowerCase())
    })

    // Narrator
    const narrator = skipNarrator
      ? null
      : await narrateSourceStory({ snapshot, venueLabel })

    const payload: PerSourcePayload = {
      ok: true,
      venue_id: venueId,
      venue_label: venueLabel,
      channel_slug: channelSlug,
      snapshot,
      narrator,
      disagreements: channelDisagreements.map((d) => ({
        id: d.id,
        axis: d.axis,
        magnitude_score: d.magnitude_score,
        stated_value: d.stated_value,
        forensic_value: d.forensic_value,
        last_observed_at: d.last_observed_at,
      })),
    }
    return NextResponse.json(payload)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[channels/${channelSlug}/snapshot] error:`, message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
