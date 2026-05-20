/**
 * D1 heat report endpoint - Tier 8 T8.2.
 *
 * GET ?venueId=X
 *   Returns the full HeatReport: distribution bands, by-lifecycle
 *   crosstab, hottest 20 active + coldest 20 active, count of active
 *   couples with no heat score.
 *
 * Auth: same pattern as the other admin/intel endpoints.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import { loadCohortData } from '@/lib/services/cohort/data'
import { buildHeatReport } from '@/lib/services/cohort/heat'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string | null = null
  if (cronAuth) {
    if (!venueIdParam) {
      return badRequest('CRON_SECRET path requires venueId param')
    }
    venueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  const supabase = createServiceClient()

  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  try {
    const data = await loadCohortData(supabase, venueId, {})
    const report = buildHeatReport(data)
    return NextResponse.json({ ok: true, venueName: venueRow.name, report })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[heat-report] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
