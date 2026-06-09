/**
 * Canonical reader endpoint — getVenueOverview (Jun-4 checkpoint #3 / Phase 3.3).
 *
 * GET → the spine-only venue overview: couples by lifecycle, recent-activity
 * feed, data-maturity read. Reads ONLY couples + touchpoints, venue-scoped.
 *
 * Auth mirrors /api/admin/intel/cohort-funnel:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, venueId in query.
 *   - else getPlatformAuth (coordinator UI) — venueId comes from auth.
 *
 * This is the additive migration target for /intel surfaces moving onto the
 * six canonical readers. It does not change any existing page; pages opt in by
 * fetching this route. The reader self-instantiates its service client.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { getVenueOverview } from '@/lib/intel/canonical'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string | null = null
  if (cronAuth) {
    if (!venueIdParam) return badRequest('CRON_SECRET path requires venueId param')
    venueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  try {
    const overview = await getVenueOverview(venueId)
    return NextResponse.json({ ok: true, overview })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[canonical/overview] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
