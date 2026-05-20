/**
 * D8 source-quality endpoint - Tier 8 T8.2.
 *
 * GET ?venueId=X
 *   Per-channel scorecard combining volume + booking rate + median
 *   response time + median heat + match precision.
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
import { buildSourceQualityReport } from '@/lib/services/cohort/source-quality'

export const maxDuration = 90

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
    const report = await buildSourceQualityReport(supabase, venueId, data)
    return NextResponse.json({ ok: true, venueName: venueRow.name, report })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[source-quality] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
