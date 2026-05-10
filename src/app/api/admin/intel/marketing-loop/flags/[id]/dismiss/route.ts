/**
 * Wave 6D — dismiss flag endpoint.
 *
 * POST /api/admin/intel/marketing-loop/flags/{id}/dismiss
 * Body: { reason: string }
 *
 * Operator dismisses the flag with a required reason. Sets
 * status='dismissed' + resolved_at=now() — terminal.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import {
  dismissMarketingFlag,
  getMarketingFlag,
} from '@/lib/services/marketing-spend/loop'

export const maxDuration = 30

interface PostBody {
  reason?: string
}

interface RouteContext {
  params: Promise<{ id: string }>
}

export async function POST(req: NextRequest, context: RouteContext) {
  const { id } = await context.params

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    return badRequest('invalid JSON body')
  }

  if (!body.reason || typeof body.reason !== 'string' || body.reason.length === 0) {
    return badRequest('reason is required to dismiss a flag')
  }

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let actorUserId: string | null = null
  let scopedVenueId: string | null = null
  if (!cronAuth) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) {
      return forbidden('demo cannot dismiss marketing flags')
    }
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    actorUserId = auth.userId
    scopedVenueId = auth.venueId
  }

  try {
    const row = await getMarketingFlag(id)
    if (!row) return notFound('flag')
    if (scopedVenueId !== null && row.venue_id !== scopedVenueId) {
      return notFound('flag')
    }

    await dismissMarketingFlag(id, {
      reason: body.reason,
      acknowledgedBy: actorUserId,
    })

    return NextResponse.json({ ok: true, flagId: id, status: 'dismissed' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
