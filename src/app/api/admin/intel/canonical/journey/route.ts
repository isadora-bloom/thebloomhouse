/**
 * Canonical reader endpoint — getCoupleJourney (Jun-4 checkpoint #3).
 *
 * GET ?coupleId=X → one couple's identity + ordered touchpoint ribbon +
 *   progression anchors + Wave-4 forensic profile + look-alike cohort.
 *   Spine-only; a foreign-venue coupleId returns couple:null (honest-empty).
 *   Additive migration target — see overview/route.ts.
 *
 * Auth mirrors /api/admin/intel/cohort-funnel. The coupleId is always taken
 * from the query; the venue is the tenancy boundary, so a couple from another
 * venue simply resolves empty rather than leaking.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { getCoupleJourney } from '@/lib/intel/canonical'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const coupleId = url.searchParams.get('coupleId')
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  if (!coupleId) return badRequest('coupleId param required')

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
    const journey = await getCoupleJourney(venueId, coupleId)
    return NextResponse.json({ ok: true, journey })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[canonical/journey] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
