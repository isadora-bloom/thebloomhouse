import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { softDeleteDocument } from '@/lib/services/intel/marketing-agency-profile'

interface RouteContext {
  params: Promise<{ id: string; documentId: string }>
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { documentId } = await ctx.params
  if (!documentId) return badRequest('document id required')
  try {
    await softDeleteDocument(documentId)
    return NextResponse.json({ ok: true })
  } catch (err) {
    return serverError(err)
  }
}
