import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  computeTbhReport,
  getLatestTbhReport,
  listTbhReports,
} from '@/lib/services/intel/marketing-agency-tbh-report'
import { createServiceClient } from '@/lib/supabase/service'

interface RouteContext {
  params: Promise<{ id: string }>
}

export const maxDuration = 120

function defaultPeriodEnd(): string {
  return new Date().toISOString().slice(0, 10)
}

function defaultPeriodStart(): string {
  // 90 days ago.
  const d = new Date(Date.now() - 90 * 86_400_000)
  return d.toISOString().slice(0, 10)
}

function isYmd(s: string | null | undefined): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

async function resolveVenueIds(
  authVenueId: string,
  authRole: string,
  sp: URLSearchParams,
): Promise<string[]> {
  const venueIdParam = sp.get('venue_id')
  const orgIdParam = sp.get('org_id')
  if (orgIdParam && (authRole === 'super_admin' || authRole === 'org_admin')) {
    const service = createServiceClient()
    const { data } = await service
      .from('venues')
      .select('id')
      .eq('org_id', orgIdParam)
    return (data ?? []).map((v) => v.id as string)
  }
  if (venueIdParam) return [venueIdParam]
  return [authVenueId]
}

/**
 * GET /api/intel/agencies/[id]/tbh-report
 *
 * Defaults: returns the most recent report for the requested mode. Pass
 * ?list=true to get a list. Pass ?period_start / ?period_end / ?mode
 * to constrain.
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')

  const sp = request.nextUrl.searchParams
  const mode = sp.get('mode') === 'shareable' ? 'shareable' : 'internal'

  try {
    if (sp.get('list') === 'true') {
      const reports = await listTbhReports({ agencyId: id, limit: 20 })
      return NextResponse.json({ reports })
    }
    const report = await getLatestTbhReport({ agencyId: id, mode })
    return NextResponse.json({ report })
  } catch (err) {
    return serverError(err)
  }
}

/**
 * POST /api/intel/agencies/[id]/tbh-report
 *
 * Generate (or re-generate) a TBH Report. Always writes a new row to
 * tbh_reports; the latest is what GET returns.
 *
 * Body:
 *   {
 *     mode?: 'internal' | 'shareable'   // default 'internal'
 *     periodStart?: 'YYYY-MM-DD'        // default 90 days ago
 *     periodEnd?: 'YYYY-MM-DD'          // default today
 *     venueId?: UUID                    // default auth.venueId
 *   }
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return NextResponse.json(
      { error: 'demo cannot generate TBH reports' },
      { status: 403 },
    )
  }
  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')

  let body: Record<string, unknown> = {}
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    body = {}
  }

  const mode = body.mode === 'shareable' ? 'shareable' : 'internal'
  const periodStart = isYmd(body.periodStart as string | null | undefined)
    ? (body.periodStart as string)
    : defaultPeriodStart()
  const periodEnd = isYmd(body.periodEnd as string | null | undefined)
    ? (body.periodEnd as string)
    : defaultPeriodEnd()
  const sp = new URLSearchParams()
  if (typeof body.venueId === 'string') sp.set('venue_id', body.venueId)

  try {
    const venueIds = await resolveVenueIds(auth.venueId, auth.role, sp)
    if (venueIds.length === 0) return badRequest('no venues in scope')
    const report = await computeTbhReport({
      agencyId: id,
      venueIds,
      periodStart,
      periodEnd,
      mode,
      generatedBy: auth.userId,
    })
    return NextResponse.json({ report }, { status: 201 })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}
