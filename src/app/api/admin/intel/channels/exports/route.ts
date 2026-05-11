/**
 * Wave 25 — list past presentation exports for a venue.
 *
 * GET /api/admin/intel/channels/exports?venueId=X
 *
 * Returns the export history (most-recent first) so the operator can
 * re-share a previously generated link.
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

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const venueId = requestedVenueId ?? auth.venueId
  if (!venueId) return badRequest('venueId required')
  const decision = await assertCanAccessVenue(auth, venueId)
  if (!decision.ok) return forbidden(decision.reason)

  try {
    const sb = createServiceClient()
    const { data, error } = await sb
      .from('channel_presentation_exports')
      .select('id, exported_at, exported_by, channel_slug, format, share_token, expires_at')
      .eq('venue_id', venueId)
      .order('exported_at', { ascending: false })
      .limit(50)
    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true, exports: data ?? [] })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
