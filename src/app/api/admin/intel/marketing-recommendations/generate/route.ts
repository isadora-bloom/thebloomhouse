/**
 * Wave 6C — marketing recommendations generate endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6C: Sonnet recommendation analyst)
 *   - bloom-wave4-5-6-master-plan.md (6C spec)
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required
 *     in body.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth;
 *     any explicit body.venueId is ignored.
 *
 * POST body:
 *   { venueId?: string, force?: boolean }
 *
 * Behaviour:
 *   - Calls generateMarketingRecommendations. Idempotent at the writer
 *     layer via 7-day input-hash short-circuit (force=true bypasses).
 *   - Returns generated count + cost + refusals.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  notFound,
} from '@/lib/api/auth-helpers'
import {
  generateMarketingRecommendations,
  MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
} from '@/lib/services/marketing-spend/recommendations'

// One Sonnet call ~30s on a venue with full data; pad for very large
// rollups + cohort.
export const maxDuration = 300

interface PostBody {
  venueId?: string
  force?: boolean
  windowDays?: number
}

interface AuthContext {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  body: PostBody,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!body.venueId || typeof body.venueId !== 'string') {
      return badRequest('CRON_SECRET path requires venueId in body')
    }
    return { ctx: { isCron: true, venueId: body.venueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return forbidden('demo cannot generate marketing recommendations')
  }
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const authResolved = await resolveAuth(req, body)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const supabase = createServiceClient()

  // Confirm venue exists.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) return notFound('venue')

  const force = body.force === true
  const windowDays =
    typeof body.windowDays === 'number' &&
    body.windowDays > 0 &&
    body.windowDays <= 1000
      ? Math.floor(body.windowDays)
      : undefined

  try {
    const result = await generateMarketingRecommendations(venueId, {
      supabase,
      force,
      windowDays,
    })
    return NextResponse.json({
      ok: true,
      venueId,
      shortCircuited: result.shortCircuited,
      generated: result.recommendations.length,
      inserted: result.inserted,
      refusals: result.refusals,
      costCents: result.costCents,
      idempotencyHash: result.idempotencyHash,
      promptVersion: result.promptVersion,
      diagnostics: result.diagnostics,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[marketing-recommendations-generate] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }
}
