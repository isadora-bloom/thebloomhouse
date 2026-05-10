/**
 * Wave 6D — conclude A/B test endpoint.
 *
 * POST /api/admin/intel/marketing-loop/ab-tests/{id}/conclude
 * Body: { force?: boolean }
 *
 * Operator forces conclusion when both arms have >= 30 events OR when
 * force=true. Returns winner + lift_pct + arm stats. Refuses to auto-
 * conclude (returns winner=null) when arms are too thin and force is
 * not set.
 *
 * Doctrine: AUTO-FLAG NEVER AUTO-EXECUTE — concluding the test does NOT
 * redirect spend. The operator reads the verdict + decides what to do.
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
  concludeAbTest,
  getAbTest,
} from '@/lib/services/marketing-spend/loop'

export const maxDuration = 60

interface PostBody {
  force?: boolean
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
      return forbidden('demo cannot conclude A/B tests')
    }
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    actorUserId = auth.userId
    scopedVenueId = auth.venueId
  }

  try {
    const row = await getAbTest(id)
    if (!row) return notFound('ab_test')
    if (scopedVenueId !== null && row.venue_id !== scopedVenueId) {
      return notFound('ab_test')
    }

    const r = await concludeAbTest({
      testId: id,
      force: body.force === true,
      decidedBy: actorUserId,
    })

    return NextResponse.json({
      ok: true,
      testId: id,
      winner: r.winner,
      liftPct: r.liftPct,
      thresholdMet: r.thresholdMet,
      variantAStats: r.variantAStats,
      variantBStats: r.variantBStats,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
