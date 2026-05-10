/**
 * Wave 6C — marketing recommendation decide endpoint.
 *
 * Operator records the accept / decline / in-progress decision against a
 * specific recommendation. Auto-promotes status; sets decided_at /
 * decided_by; persists optional decision_note. Mirrors the
 * intel-matches/dismiss + intel-matches/action pattern from Wave 5C.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. recommendationId
 *     required.
 *   - else getPlatformAuth (coordinator UI). The recommendation must
 *     belong to the caller's venue (cross-venue tenancy guard).
 *
 * POST body:
 *   { recommendationId, decision, note? }
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
  decideMarketingRecommendation,
  getMarketingRecommendation,
} from '@/lib/services/marketing-spend/recommendations'

export const maxDuration = 30

const VALID_DECISIONS: ReadonlySet<string> = new Set([
  'accepted',
  'declined',
  'in_progress',
  'completed',
])

interface PostBody {
  recommendationId?: string
  decision?: string
  note?: string | null
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    return badRequest('invalid JSON body')
  }

  if (!body.recommendationId || typeof body.recommendationId !== 'string') {
    return badRequest('recommendationId required')
  }
  if (!body.decision || !VALID_DECISIONS.has(body.decision)) {
    return badRequest(
      'decision must be one of: accepted | declined | in_progress | completed',
    )
  }

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let actorUserId: string | null = null
  let scopedVenueId: string | null = null
  if (!cronAuth) {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) {
      return forbidden('demo cannot decide on marketing recommendations')
    }
    if (!auth.venueId) return forbidden('caller has no resolved venue')
    actorUserId = auth.userId
    scopedVenueId = auth.venueId
  }

  try {
    // Tenancy guard: confirm the rec exists + belongs to caller's venue.
    const row = await getMarketingRecommendation(body.recommendationId)
    if (!row) return notFound('recommendation')
    if (scopedVenueId !== null && row.venue_id !== scopedVenueId) {
      return notFound('recommendation')
    }

    await decideMarketingRecommendation(body.recommendationId, {
      decision: body.decision as
        | 'accepted'
        | 'declined'
        | 'in_progress'
        | 'completed',
      note: body.note ?? null,
      decidedBy: actorUserId,
    })

    return NextResponse.json({
      ok: true,
      recommendationId: body.recommendationId,
      decision: body.decision,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
