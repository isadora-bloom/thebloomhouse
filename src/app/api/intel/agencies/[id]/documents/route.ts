import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import {
  listDocuments,
  createDocument,
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
    const documents = await listDocuments(id)
    return NextResponse.json({ documents })
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
    const document = await createDocument({
      agencyId: id,
      engagementId:
        typeof body.engagementId === 'string' ? body.engagementId : null,
      name,
      fileUrl: typeof body.fileUrl === 'string' ? body.fileUrl : null,
      kind: typeof body.kind === 'string' ? body.kind : null,
      effectiveDate:
        typeof body.effectiveDate === 'string' ? body.effectiveDate : null,
      expiresAt: typeof body.expiresAt === 'string' ? body.expiresAt : null,
      notes: typeof body.notes === 'string' ? body.notes : null,
      uploadedBy: auth.userId,
    })
    return NextResponse.json({ document }, { status: 201 })
  } catch (err) {
    if (err instanceof Error) return badRequest(err.message)
    return serverError(err)
  }
}
