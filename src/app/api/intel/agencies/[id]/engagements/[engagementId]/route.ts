import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  endEngagement,
  softDeleteEngagement,
} from '@/lib/services/intel/marketing-agencies'

interface RouteContext {
  params: Promise<{ id: string; engagementId: string }>
}

/**
 * PATCH /api/intel/agencies/[id]/engagements/[engagementId]
 *
 * Used to end an engagement: { endedAt: 'YYYY-MM-DD' }.
 * For other updates, POST to the parent route re-upserts.
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const { engagementId } = await ctx.params
  if (!engagementId) return badRequest('engagement id required')

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }

  const endedAt = typeof body.endedAt === 'string' ? body.endedAt : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endedAt)) {
    return badRequest('endedAt must be YYYY-MM-DD')
  }

  try {
    const engagement = await endEngagement(engagementId, endedAt)
    return NextResponse.json({ engagement })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}

/**
 * DELETE /api/intel/agencies/[id]/engagements/[engagementId]
 *
 * Soft-delete an engagement. Preserves history for TBH Reports.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const { engagementId } = await ctx.params
  if (!engagementId) return badRequest('engagement id required')

  try {
    await softDeleteEngagement(engagementId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
