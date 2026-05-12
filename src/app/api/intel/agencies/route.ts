import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  listAgenciesForVenue,
  createAgency,
  type CreateAgencyInput,
} from '@/lib/services/intel/marketing-agencies'
import { createServiceClient } from '@/lib/supabase/service'

/**
 * GET /api/intel/agencies
 *
 * Wave 6E. List marketing agencies visible from the caller's venue
 * scope. Returns agencies owned by the venue/org plus any agency
 * the venue has an engagement to.
 *
 * Query params:
 *   ?venue_id=UUID  — override scope (defaults to auth.venueId)
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const sp = request.nextUrl.searchParams
  const venueId = sp.get('venue_id') ?? auth.venueId
  if (!venueId) return badRequest('venue_id required')

  try {
    const agencies = await listAgenciesForVenue(venueId)
    return NextResponse.json({ agencies })
  } catch (err) {
    return serverError(err)
  }
}

/**
 * POST /api/intel/agencies
 *
 * Body:
 *   {
 *     name: string,
 *     scope: 'venue' | 'org',  // determines whether org_id or venue_id is set
 *     website?, contactName?, contactEmail?, contactPhone?,
 *     defaultMonthlyRetainerCents?, performanceFeePct?,
 *     services?: string[],
 *     notes?
 *   }
 */
export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) return badRequest('name required')

  const scope = body.scope === 'org' ? 'org' : 'venue'

  // Resolve venue/org context. If scope=org, look up auth.orgId.
  // If scope=venue, use auth.venueId.
  let orgId: string | null = null
  let venueId: string | null = null

  if (scope === 'org') {
    if (!auth.orgId) {
      // Fallback: pull from the venue record. Same-org coordinator
      // who doesn't have org_id directly on user_profiles still owns
      // the venue.
      const service = createServiceClient()
      const { data: v } = await service
        .from('venues')
        .select('org_id')
        .eq('id', auth.venueId)
        .maybeSingle()
      orgId = (v?.org_id as string | null) ?? null
    } else {
      orgId = auth.orgId
    }
    if (!orgId) {
      return badRequest('cannot create org-scope agency: no org context')
    }
  } else {
    venueId = auth.venueId
  }

  const input: CreateAgencyInput = {
    orgId,
    venueId,
    name,
    website: typeof body.website === 'string' ? body.website : null,
    contactName: typeof body.contactName === 'string' ? body.contactName : null,
    contactEmail: typeof body.contactEmail === 'string' ? body.contactEmail : null,
    contactPhone: typeof body.contactPhone === 'string' ? body.contactPhone : null,
    defaultMonthlyRetainerCents:
      typeof body.defaultMonthlyRetainerCents === 'number'
        ? body.defaultMonthlyRetainerCents
        : null,
    performanceFeePct:
      typeof body.performanceFeePct === 'number' ? body.performanceFeePct : null,
    services: Array.isArray(body.services)
      ? body.services.filter((x): x is string => typeof x === 'string')
      : [],
    notes: typeof body.notes === 'string' ? body.notes : null,
    createdBy: auth.userId,
  }

  try {
    const agency = await createAgency(input)
    return NextResponse.json({ agency }, { status: 201 })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}
