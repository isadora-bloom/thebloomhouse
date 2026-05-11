/**
 * Wave 25 — generate presentation export.
 *
 * POST /api/admin/intel/channels/[channelSlug]/export?venueId=X&format=pdf
 * body: { windowDays?: 30 | 90 | 365 }
 *
 * Computes (or re-uses cached) snapshot, narrates, generates the export
 * body, persists a frozen snapshot into channel_presentation_exports,
 * returns share_token + download_url.
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
import { generateExport, type ExportFormat } from '@/lib/services/channel-intel-hub/export'
import { slugToPlatform } from '@/lib/services/channel-intel-hub/slugs'

export const maxDuration = 180

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ channelSlug: string }> },
) {
  const { channelSlug } = await params
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')
  const format = (url.searchParams.get('format') ?? 'pdf') as ExportFormat
  if (!['pdf', 'pptx', 'csv', 'json'].includes(format)) {
    return badRequest('format must be pdf / pptx / csv / json')
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const venueId = requestedVenueId ?? auth.venueId
  const decision = await assertCanAccessVenue(auth, venueId)
  if (!decision.ok) return forbidden(decision.reason)

  let body: { windowDays?: number; skipNarrator?: boolean } = {}
  try {
    body = (await req.json()) as { windowDays?: number; skipNarrator?: boolean }
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
      persist: false,
      supabase: sb,
    })
    let venueLabel = 'venue'
    const { data: venueRow } = await sb.from('venues').select('name').eq('id', venueId).maybeSingle()
    if (venueRow && typeof (venueRow as { name?: string }).name === 'string') {
      venueLabel = (venueRow as { name: string }).name
    }
    const narrator = body.skipNarrator
      ? null
      : await narrateSourceStory({ snapshot, venueLabel })

    const result = await generateExport({
      venueId,
      venueLabel,
      snapshot,
      narrator,
      format,
      exportedBy: auth.userId,
      supabase: sb,
    })

    return NextResponse.json({
      ok: true,
      share_token: result.share_token,
      download_url: result.download_url,
      content_type: result.content_type,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[channels/${channelSlug}/export] error:`, message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
