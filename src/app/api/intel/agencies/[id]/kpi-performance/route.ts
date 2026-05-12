import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { computeKpiPerformance } from '@/lib/services/intel/marketing-agency-kpi-performance'
import { createServiceClient } from '@/lib/supabase/service'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * GET /api/intel/agencies/[id]/kpi-performance
 *
 * Wave 6E depth pass. Resolves agency_kpi_commitments against measured
 * actuals from computeAgencyROI + computeAgencyBreakdown.
 *
 * Query params:
 *   ?venue_id=UUID         — single venue (defaults to auth.venueId)
 *   ?org_id=UUID           — every venue in org (admin only)
 *   ?window=DAYS           — measurement window, default 90
 *   ?include_retired=true  — also include retired KPIs (for historical reports)
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')

  const sp = request.nextUrl.searchParams
  const venueIdParam = sp.get('venue_id')
  const orgIdParam = sp.get('org_id')
  const windowParam = parseInt(sp.get('window') ?? '90', 10)
  const windowDays = Number.isFinite(windowParam) && windowParam > 0 ? windowParam : 90
  const includeRetired = sp.get('include_retired') === 'true'

  const service = createServiceClient()
  let venueIds: string[] = []
  try {
    if (orgIdParam) {
      if (auth.role === 'super_admin' || auth.role === 'org_admin') {
        const { data } = await service
          .from('venues')
          .select('id')
          .eq('org_id', orgIdParam)
        venueIds = (data ?? []).map((v) => v.id as string)
      } else {
        venueIds = [auth.venueId]
      }
    } else if (venueIdParam) {
      venueIds = [venueIdParam]
    } else {
      venueIds = [auth.venueId]
    }
    if (venueIds.length === 0) {
      return NextResponse.json({ rows: [], message: 'no venues in scope' })
    }
    const rows = await computeKpiPerformance({
      agencyId: id,
      venueIds,
      windowDays,
      includeRetired,
    })
    return NextResponse.json({ rows })
  } catch (err) {
    return serverError(err)
  }
}
