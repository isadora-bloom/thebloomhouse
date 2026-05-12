import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  notFound,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  getAgencyById,
  updateAgency,
  softDeleteAgency,
  listEngagementsForAgency,
  type UpdateAgencyInput,
} from '@/lib/services/intel/marketing-agencies'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * GET /api/intel/agencies/[id]
 *
 * Returns the agency plus its engagements visible to the caller
 * (scoped to the caller's venue).
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')

  try {
    const agency = await getAgencyById(id)
    if (!agency) return notFound('Agency')

    // Engagement visibility — scope to the caller's venue unless
    // they have org_admin access in which case fetch all engagements
    // for the agency.
    const venueScope =
      auth.role === 'super_admin' || auth.role === 'org_admin'
        ? undefined
        : [auth.venueId]
    const engagements = await listEngagementsForAgency(id, {
      venueIds: venueScope,
    })

    return NextResponse.json({ agency, engagements })
  } catch (err) {
    return serverError(err)
  }
}

/**
 * PATCH /api/intel/agencies/[id]
 */
export async function PATCH(request: NextRequest, ctx: RouteContext) {
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

  const patch: UpdateAgencyInput = {}
  if (typeof body.name === 'string') patch.name = body.name
  if (body.website === null || typeof body.website === 'string') patch.website = body.website as string | null
  if (body.contactName === null || typeof body.contactName === 'string') patch.contactName = body.contactName as string | null
  if (body.contactEmail === null || typeof body.contactEmail === 'string') patch.contactEmail = body.contactEmail as string | null
  if (body.contactPhone === null || typeof body.contactPhone === 'string') patch.contactPhone = body.contactPhone as string | null
  if (body.defaultMonthlyRetainerCents === null || typeof body.defaultMonthlyRetainerCents === 'number') {
    patch.defaultMonthlyRetainerCents = body.defaultMonthlyRetainerCents as number | null
  }
  if (body.performanceFeePct === null || typeof body.performanceFeePct === 'number') {
    patch.performanceFeePct = body.performanceFeePct as number | null
  }
  if (Array.isArray(body.services)) {
    patch.services = body.services.filter((x): x is string => typeof x === 'string')
  }
  if (body.notes === null || typeof body.notes === 'string') patch.notes = body.notes as string | null

  try {
    const agency = await updateAgency(id, patch)
    return NextResponse.json({ agency })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}

/**
 * DELETE /api/intel/agencies/[id]
 *
 * Soft-delete only. Preserves engagement + spend history.
 */
export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')

  try {
    await softDeleteAgency(id)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
