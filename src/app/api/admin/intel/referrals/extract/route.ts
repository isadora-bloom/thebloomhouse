/**
 * Wave 14 — referral extraction + resolve endpoint.
 *
 * POST /api/admin/intel/referrals/extract
 *
 * Body: { weddingId: string }
 *
 * Auth (mirrors /api/admin/intel/couple-derive):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path
 *   - else getPlatformAuth (coordinator UI). Validates wedding belongs
 *     to caller's venue.
 *
 * Behaviour:
 *   - Runs extractReferrers (one Haiku call) → resolveReferrer for each
 *     mention (writes attribution_event rows). Returns the structured
 *     summary.
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
import { extractReferrers } from '@/lib/services/intel/referrals/extract'
import { resolveReferrer } from '@/lib/services/intel/referrals/resolve'

export const maxDuration = 120

interface PostBody {
  weddingId?: string
}

interface AuthContext {
  isCron: boolean
  venueId: string | null
}

async function resolveAuth(
  req: NextRequest,
  weddingId: string | null,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!weddingId) {
      return badRequest('CRON_SECRET path requires weddingId')
    }
    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      .from('weddings')
      .select('venue_id, merged_into_id')
      .eq('id', weddingId)
      .maybeSingle()
    if (!wedding) return notFound('wedding')
    const w = wedding as { venue_id: string; merged_into_id: string | null }
    if (w.merged_into_id) {
      return badRequest('wedding is tombstoned (merged_into_id set)')
    }
    return { ctx: { isCron: true, venueId: w.venue_id } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run referral extraction')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  if (weddingId) {
    const supabase = createServiceClient()
    const { data: wedding } = await supabase
      .from('weddings')
      .select('venue_id, merged_into_id')
      .eq('id', weddingId)
      .maybeSingle()
    if (!wedding) return notFound('wedding')
    const w = wedding as { venue_id: string; merged_into_id: string | null }
    if (w.venue_id !== auth.venueId) {
      return forbidden('wedding does not belong to your venue')
    }
    if (w.merged_into_id) {
      return badRequest('wedding is tombstoned (merged_into_id set)')
    }
  }
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const weddingId = typeof body.weddingId === 'string' ? body.weddingId : null
  if (!weddingId) return badRequest('weddingId required')

  const authResolved = await resolveAuth(req, weddingId)
  if (authResolved instanceof NextResponse) return authResolved
  const { ctx } = authResolved

  const supabase = createServiceClient()

  let result
  try {
    result = await extractReferrers({ weddingId }, { supabase })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[referrals/extract] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }

  // Resolve each mention. Failures here are non-fatal — they leave the
  // attribution_event un-written but the extraction itself succeeded.
  const resolutions: Array<{
    referrer_name: string
    relationship: string
    confidence_0_100: number
    outcome: string
    detail?: unknown
  }> = []
  for (const mention of result.output.referrer_mentions) {
    try {
      const r = await resolveReferrer({
        newWeddingId: weddingId,
        venueId: ctx.venueId!,
        mention,
        supabase,
      })
      resolutions.push({
        referrer_name: mention.referrer_name,
        relationship: mention.relationship_to_couple,
        confidence_0_100: mention.confidence_0_100,
        outcome: r.kind,
        detail:
          r.kind === 'matched'
            ? { referrerWeddingId: r.referrerWeddingId, attributionEventId: r.attributionEventId }
            : r.kind === 'ambiguous'
              ? {
                  candidateWeddingIds: r.candidateWeddingIds,
                  attributionEventId: r.attributionEventId,
                }
              : r.kind === 'deferred'
                ? { attributionEventId: r.attributionEventId }
                : { reason: r.reason },
      })
    } catch (err) {
      resolutions.push({
        referrer_name: mention.referrer_name,
        relationship: mention.relationship_to_couple,
        confidence_0_100: mention.confidence_0_100,
        outcome: 'error',
        detail: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  return NextResponse.json({
    ok: true,
    weddingId,
    venueId: result.venueId,
    promptVersion: result.promptVersion,
    costCents: result.costCents,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    mentions: result.output.referrer_mentions,
    refusals: result.output.refusals,
    resolutions,
  })
}
