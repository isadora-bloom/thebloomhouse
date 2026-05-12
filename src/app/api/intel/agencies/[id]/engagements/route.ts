import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
  assertCanAccessVenue,
  forbidden,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  upsertEngagement,
  type UpsertEngagementInput,
} from '@/lib/services/intel/marketing-agencies'

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * POST /api/intel/agencies/[id]/engagements
 *
 * Upsert the (venue, agency) engagement. If an active engagement
 * already exists for this pair, the service updates it; otherwise a
 * new row lands.
 *
 * Body:
 *   {
 *     venueId: UUID,
 *     startedAt: 'YYYY-MM-DD',
 *     endedAt?: 'YYYY-MM-DD' | null,
 *     monthlyFeeCents?: number,
 *     managedChannels?: string[],   // marketing_channels.key values
 *     scopeDescription?: string,
 *     notes?: string
 *   }
 */
export async function POST(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const { id: agencyId } = await ctx.params
  if (!agencyId) return badRequest('agency id required')

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }

  const venueId = typeof body.venueId === 'string' ? body.venueId : auth.venueId
  const access = await assertCanAccessVenue(auth, venueId)
  if (!access.ok) return forbidden(access.reason)

  const startedAt = typeof body.startedAt === 'string' ? body.startedAt : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startedAt)) {
    return badRequest('startedAt must be YYYY-MM-DD')
  }

  const input: UpsertEngagementInput = {
    venueId,
    agencyId,
    startedAt,
    endedAt:
      typeof body.endedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.endedAt)
        ? body.endedAt
        : null,
    monthlyFeeCents:
      typeof body.monthlyFeeCents === 'number' && body.monthlyFeeCents >= 0
        ? Math.round(body.monthlyFeeCents)
        : 0,
    managedChannels: Array.isArray(body.managedChannels)
      ? body.managedChannels.filter((x): x is string => typeof x === 'string')
      : [],
    scopeDescription:
      typeof body.scopeDescription === 'string' ? body.scopeDescription : null,
    notes: typeof body.notes === 'string' ? body.notes : null,
  }

  try {
    const engagement = await upsertEngagement(input)
    return NextResponse.json({ engagement })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}
