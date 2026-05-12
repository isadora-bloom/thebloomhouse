import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  listActivity,
  createActivity,
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
  const limitParam = parseInt(request.nextUrl.searchParams.get('limit') ?? '50', 10)
  const limit = Number.isFinite(limitParam) ? limitParam : 50
  try {
    const activity = await listActivity(id, { limit })
    return NextResponse.json({ activity })
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
  const summary = typeof body.summary === 'string' ? body.summary : ''
  if (!summary.trim()) return badRequest('summary required')
  try {
    const activity = await createActivity({
      agencyId: id,
      engagementId:
        typeof body.engagementId === 'string' ? body.engagementId : null,
      venueId: typeof body.venueId === 'string' ? body.venueId : auth.venueId,
      occurredAt:
        typeof body.occurredAt === 'string' ? body.occurredAt : undefined,
      kind: typeof body.kind === 'string' ? body.kind : 'note',
      summary,
      body: typeof body.body === 'string' ? body.body : null,
      payload:
        body.payload && typeof body.payload === 'object'
          ? (body.payload as Record<string, unknown>)
          : {},
      recordedBy: auth.userId,
    })
    return NextResponse.json({ activity }, { status: 201 })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}
