import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  retireKpi,
  softDeleteKpi,
} from '@/lib/services/intel/marketing-agency-profile'

interface RouteContext {
  params: Promise<{ id: string; kpiId: string }>
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { kpiId } = await ctx.params
  if (!kpiId) return badRequest('kpi id required')
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    body = {}
  }
  const endedAt = typeof body.endedAt === 'string' ? body.endedAt : undefined
  try {
    const kpi = await retireKpi(kpiId, endedAt)
    return NextResponse.json({ kpi })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { kpiId } = await ctx.params
  if (!kpiId) return badRequest('kpi id required')
  try {
    await softDeleteKpi(kpiId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
