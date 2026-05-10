/**
 * Wave 5D — venue thesis read endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D onboarding bootstrap)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *
 * GET ?venueId=X
 *   Returns the stored venue_thesis row or 404. No LLM call. Used by
 *   the /admin/onboarding/thesis dashboard + VenueThesisPanel.
 *
 * Auth (mirrors /api/admin/intel/cohort-rollup):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required
 *     as query param.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth;
 *     any explicit ?venueId is ignored.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { getStoredVenueThesis } from '@/lib/services/intel/onboarding/generate-thesis'

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
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

  const stored = await getStoredVenueThesis(venueId)
  if (!stored) return notFound('venue_thesis')

  return NextResponse.json({
    ok: true,
    venueId: stored.venueId,
    thesis: stored.thesis,
    couplesAtGeneration: stored.couplesAtGeneration,
    lastGeneratedAt: stored.lastGeneratedAt,
    generationCount: stored.generationCount,
    promptVersion: stored.promptVersion,
    cumulativeCostCents: stored.costCents,
  })
}
