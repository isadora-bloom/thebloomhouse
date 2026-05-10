/**
 * Wave 6D — acknowledge flag endpoint.
 *
 * POST /api/admin/intel/marketing-loop/flags/{id}/acknowledge
 * Body: { note?: string }
 *
 * Operator records that they've seen + understood the flag. Sets
 * status='acknowledged'. Auto-flag never auto-actions; the next state
 * (actioned / dismissed) is also operator-decided.
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
  acknowledgeMarketingFlag,
  getMarketingFlag,
} from '@/lib/services/marketing-spend/loop'

export const maxDuration = 30

interface PostBody {
  note?: string | null
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
    body = {}
  }

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let actorUserId: string | null = null
  let scopedVenueId: string | null = null
  if (!cronAuth) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) {
      return forbidden('demo cannot acknowledge marketing flags')
    }
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    actorUserId = auth.userId
    scopedVenueId = auth.venueId
  }

  try {
    const row = await getMarketingFlag(id)
    if (!row) return notFound('flag')
    if (scopedVenueId !== null && row.venue_id !== scopedVenueId) {
      // Don't disclose existence cross-venue.
      return notFound('flag')
    }

    await acknowledgeMarketingFlag(id, {
      note: body.note ?? null,
      acknowledgedBy: actorUserId,
    })

    return NextResponse.json({ ok: true, flagId: id, status: 'acknowledged' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
