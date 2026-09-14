import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  computePlatformShift,
  fetchMarketingMetricRows,
} from '@/lib/intel/tool-sources/platform-shift'
import { buildPlatformShiftView } from '@/lib/intel/adapters/platform-shift-view'

/**
 * GET /api/intel/platform-shift
 *
 * Same computation the `get_platform_engagement_shift` tool source runs
 * (src/lib/intel/tool-sources/platform-shift.ts), so the /intel/sources
 * card and Ask-your-data give the same answer to "is engagement moving
 * from Instagram to TikTok" — one number per question, per
 * INTEL-CANONICAL-API.md §1.
 *
 * At venue scope this is one venue's rows; at group/company scope the
 * rows from every venue in scope are combined before the monthly rollup,
 * the same "aggregate across scope" behaviour /api/intel/reach uses.
 *
 * ?months=N overrides the default 6-month trailing window.
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const venueIds = await resolveScopeVenueIds()
  if (venueIds.length === 0) {
    return NextResponse.json({
      view: buildPlatformShiftView(computePlatformShift([], new Date().toISOString().slice(0, 10))),
    })
  }

  const monthsParam = request.nextUrl.searchParams.get('months')
  const months = monthsParam ? Number(monthsParam) : undefined

  const supabase = createServiceClient()
  const rowsPerVenue = await Promise.all(
    venueIds.map((id) => fetchMarketingMetricRows(supabase, id)),
  )
  const rows = rowsPerVenue.flat()

  const today = new Date().toISOString().slice(0, 10)
  const result = computePlatformShift(rows, today, months)

  return NextResponse.json({ view: buildPlatformShiftView(result) })
}
