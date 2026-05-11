/**
 * Wave 13 — review-solicitation draft generation endpoint.
 *
 * Dual auth (mirrors /api/admin/intel/couple-derive):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, weddingId in body
 *   - else getPlatformAuth (coordinator UI), venueId from session, and
 *     we validate the requested wedding belongs to that venue.
 *
 * POST body:
 *   { weddingId: string, channel?: 'knot' | 'weddingwire' | 'google' | 'yelp' | 'facebook' | 'other' }
 *
 * Behaviour:
 *   - Dedupes against prior request within 30 days (the service enforces).
 *   - Picks target channel deterministically when no override given.
 *   - One Sonnet call (~$0.02). Writes a row to review_solicit_requests
 *     and a draft to `drafts` (status='pending', NOT auto-sent).
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
import { solicitReview, REVIEW_SOLICIT_PROMPT_VERSION } from '@/lib/services/reviews/solicit'
import type { ReviewTargetChannel } from '@/config/prompts/review-solicit'

export const maxDuration = 120

const VALID_CHANNELS: ReadonlyArray<ReviewTargetChannel> = [
  'knot',
  'weddingwire',
  'google',
  'yelp',
  'facebook',
  'other',
]

interface PostBody {
  weddingId?: string
  channel?: string
}

async function resolveAuth(
  req: NextRequest,
  weddingId: string | null,
): Promise<{ venueId: string } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!weddingId) return badRequest('CRON_SECRET path requires weddingId')
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
    return { venueId: w.venue_id }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run review solicitation')
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
  return { venueId: auth.venueId }
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

  let channel: ReviewTargetChannel | undefined
  if (typeof body.channel === 'string') {
    if (!VALID_CHANNELS.includes(body.channel as ReviewTargetChannel)) {
      return badRequest(`invalid channel: ${body.channel}`)
    }
    channel = body.channel as ReviewTargetChannel
  }

  const authResolved = await resolveAuth(req, weddingId)
  if (authResolved instanceof NextResponse) return authResolved

  const supabase = createServiceClient()

  try {
    const result = await solicitReview({ weddingId, channel, supabase })
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, reason: result.reason },
        { status: 422 },
      )
    }
    return NextResponse.json({
      ok: true,
      requestId: result.requestId,
      draftId: result.draftId,
      weddingId: result.weddingId,
      venueId: result.venueId,
      targetChannel: result.targetChannel,
      reviewLinkUrl: result.reviewLinkUrl,
      draft: result.draft,
      promptVersion: result.promptVersion,
      costCents: result.costCents,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[review-solicit] route error:', message)
    return NextResponse.json(
      { ok: false, error: message, promptVersion: REVIEW_SOLICIT_PROMPT_VERSION },
      { status: 500 },
    )
  }
}
