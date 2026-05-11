/**
 * Wave 14 — alumni cohorts list endpoint.
 *
 * GET /api/admin/intel/alumni/list?venueId=X
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId param required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, badRequest } from '@/lib/api/auth-helpers'
import { listAlumniCohorts } from '@/lib/services/intel/alumni/generate'

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

  const archetypes = await listAlumniCohorts(venueId)
  return NextResponse.json({
    ok: true,
    venueId,
    count: archetypes.length,
    archetypes,
  })
}
