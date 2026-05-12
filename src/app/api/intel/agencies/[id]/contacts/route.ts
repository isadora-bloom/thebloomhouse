import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  listContacts,
  createContact,
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
  try {
    const contacts = await listContacts(id)
    return NextResponse.json({ contacts })
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
  const name = typeof body.name === 'string' ? body.name : ''
  if (!name.trim()) return badRequest('name required')
  try {
    const contact = await createContact({
      agencyId: id,
      name,
      email: typeof body.email === 'string' ? body.email : null,
      phone: typeof body.phone === 'string' ? body.phone : null,
      role: typeof body.role === 'string' ? body.role : null,
      notes: typeof body.notes === 'string' ? body.notes : null,
      isPrimary: body.isPrimary === true,
    })
    return NextResponse.json({ contact }, { status: 201 })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}
