import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  listKpis,
  createKpi,
} from '@/lib/services/intel/marketing-agency-profile'

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')
  const activeOnly = request.nextUrl.searchParams.get('active') === 'true'
  try {
    const kpis = await listKpis(id, { activeOnly })
    return NextResponse.json({ kpis })
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }
  const metricName = typeof body.metricName === 'string' ? body.metricName : ''
  const targetValueRaw = body.targetValue
  const targetValue =
    typeof targetValueRaw === 'number' ? targetValueRaw : Number(targetValueRaw)
  if (!metricName.trim()) return badRequest('metricName required')
  if (!Number.isFinite(targetValue)) return badRequest('targetValue required (number)')
  try {
    const kpi = await createKpi({
      agencyId: id,
      engagementId:
        typeof body.engagementId === 'string' ? body.engagementId : null,
      metricName,
      targetValue,
      targetUnit: typeof body.targetUnit === 'string' ? body.targetUnit : 'count',
      targetWindow:
        typeof body.targetWindow === 'string' ? body.targetWindow : 'month',
      notes: typeof body.notes === 'string' ? body.notes : null,
      effectiveFrom:
        typeof body.effectiveFrom === 'string' ? body.effectiveFrom : undefined,
    })
    return NextResponse.json({ kpi }, { status: 201 })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}
