import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { softDeleteActivity } from '@/lib/services/intel/marketing-agency-profile'

interface RouteContext {
  params: Promise<{ id: string; activityId: string }>
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { activityId } = await ctx.params
  if (!activityId) return badRequest('activity id required')
  try {
    await softDeleteActivity(activityId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
