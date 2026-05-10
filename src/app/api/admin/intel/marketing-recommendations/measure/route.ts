/**
 * Wave 6C — marketing recommendation measurement endpoint.
 *
 * Operator records the actual outcome (in cents) after the
 * recommendation has been actioned. Auto-promotes status to 'completed'
 * + sets actioned_at. The dashboard renders projected vs measured
 * variance once measured_outcome_cents is set.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. recommendationId
 *     required.
 *   - else getPlatformAuth (coordinator UI). The recommendation must
 *     belong to the caller's venue.
 *
 * POST body:
 *   { recommendationId, measuredOutcomeCents }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import {
  measureMarketingRecommendation,
  getMarketingRecommendation,
} from '@/lib/services/marketing-spend/recommendations'

export const maxDuration = 30

interface PostBody {
  recommendationId?: string
  measuredOutcomeCents?: number
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    return badRequest('invalid JSON body')
  }

  if (!body.recommendationId || typeof body.recommendationId !== 'string') {
    return badRequest('recommendationId required')
  }
  if (
    typeof body.measuredOutcomeCents !== 'number' ||
    !Number.isFinite(body.measuredOutcomeCents)
  ) {
    return badRequest('measuredOutcomeCents must be a finite number')
  }

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let scopedVenueId: string | null = null
  if (!cronAuth) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) {
      return forbidden('demo cannot measure marketing recommendations')
    }
    if (!auth.venueId) return forbidden('caller has no resolved venue')
    scopedVenueId = auth.venueId
  }

  try {
    const row = await getMarketingRecommendation(body.recommendationId)
    if (!row) return notFound('recommendation')
    if (scopedVenueId !== null && row.venue_id !== scopedVenueId) {
      return notFound('recommendation')
    }

    await measureMarketingRecommendation(
      body.recommendationId,
      body.measuredOutcomeCents,
    )

    return NextResponse.json({
      ok: true,
      recommendationId: body.recommendationId,
      measuredOutcomeCents: Math.round(body.measuredOutcomeCents),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
