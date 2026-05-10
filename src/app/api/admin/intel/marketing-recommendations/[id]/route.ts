/**
 * Wave 6C — single marketing recommendation detail endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. Returns the row
 *     regardless of venue.
 *   - else getPlatformAuth (coordinator UI). The row must belong to the
 *     caller's venue.
 *
 * GET /api/admin/intel/marketing-recommendations/{id}
 * Returns: { ok, recommendation }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  notFound,
} from '@/lib/api/auth-helpers'
import { getMarketingRecommendation } from '@/lib/services/marketing-spend/recommendations'

export const maxDuration = 30

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(req: NextRequest, context: RouteContext) {
  const { id } = await context.params

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let scopedVenueId: string | null = null
  if (!cronAuth) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) {
      return forbidden('demo cannot read marketing recommendations')
    }
    if (!auth.venueId) return forbidden('caller has no resolved venue')
    scopedVenueId = auth.venueId
  }

  try {
    const row = await getMarketingRecommendation(id)
    if (!row) return notFound('recommendation')
    if (scopedVenueId !== null && row.venue_id !== scopedVenueId) {
      // Don't disclose existence to a different venue.
      return notFound('recommendation')
    }
    return NextResponse.json({ ok: true, recommendation: row })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
