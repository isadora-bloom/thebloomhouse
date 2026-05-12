import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  updateContact,
  softDeleteContact,
} from '@/lib/services/intel/marketing-agency-profile'

interface RouteContext {
  params: Promise<{ id: string; contactId: string }>
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { contactId } = await ctx.params
  if (!contactId) return badRequest('contact id required')
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }
  try {
    const contact = await updateContact(contactId, {
      name: typeof body.name === 'string' ? body.name : undefined,
      email:
        body.email === null || typeof body.email === 'string' ? (body.email as string | null) : undefined,
      phone:
        body.phone === null || typeof body.phone === 'string' ? (body.phone as string | null) : undefined,
      role:
        body.role === null || typeof body.role === 'string' ? (body.role as string | null) : undefined,
      notes:
        body.notes === null || typeof body.notes === 'string' ? (body.notes as string | null) : undefined,
      isPrimary: typeof body.isPrimary === 'boolean' ? body.isPrimary : undefined,
    })
    return NextResponse.json({ contact })
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
  const { contactId } = await ctx.params
  if (!contactId) return badRequest('contact id required')
  try {
    await softDeleteContact(contactId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
