/**
 * Wave 6D — mark flag as actioned endpoint.
 *
 * POST /api/admin/intel/marketing-loop/flags/{id}/action
 * Body: { note?: string }
 *
 * Operator records that they've taken action based on the flag (e.g.
 * paused a campaign, scaled a winner). Sets status='actioned'. The
 * actual spend mutation happens OUTSIDE this system — the flag is the
 * ledger entry, never the auto-executor.
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
  actionMarketingFlag,
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
      return forbidden('demo cannot action marketing flags')
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

    await actionMarketingFlag(id, {
      note: body.note ?? null,
      acknowledgedBy: actorUserId,
    })

    return NextResponse.json({ ok: true, flagId: id, status: 'actioned' })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
