/**
 * Wave 13 — tour-prep brief generation endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 13 extends tour pipeline with a pre-tour
 *     brief generated 24h before each tour)
 *
 * Dual auth (mirrors /api/admin/intel/couple-derive):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path, tourId in body
 *   - else getPlatformAuth (coordinator UI), venueId from session, and
 *     we validate the requested tour belongs to that venue.
 *
 * POST body:
 *   { tourId: string, force?: boolean }
 *
 * Behaviour:
 *   - force=false (default): if a brief exists AND generated_at is within
 *     the last 24h, return cached brief, do NOT spend LLM.
 *   - force=true OR no brief OR stale: run generateTourPrepBrief (one
 *     Sonnet call), upsert, return the fresh brief.
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
  generateTourPrepBrief,
  getStoredTourPrepBrief,
  TOUR_PREP_BRIEF_PROMPT_VERSION,
} from '@/lib/services/tour/prep-brief'

export const maxDuration = 120

const CACHE_WINDOW_MS = 24 * 60 * 60 * 1000

interface PostBody {
  tourId?: string
  force?: boolean
}

interface AuthContext {
  isCron: boolean
  venueId: string | null
}

async function resolveAuth(
  req: NextRequest,
  tourId: string | null,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!tourId) {
      return badRequest('CRON_SECRET path requires tourId')
    }
    const supabase = createServiceClient()
    const { data: tour } = await supabase
      .from('tours')
      .select('venue_id')
      .eq('id', tourId)
      .maybeSingle()
    if (!tour) return notFound('tour')
    return { ctx: { isCron: true, venueId: (tour as { venue_id: string }).venue_id } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run tour-prep brief')
  if (!auth.venueId) return badRequest('caller has no resolved venue')

  if (tourId) {
    const supabase = createServiceClient()
    const { data: tour } = await supabase
      .from('tours')
      .select('venue_id')
      .eq('id', tourId)
      .maybeSingle()
    if (!tour) return notFound('tour')
    if ((tour as { venue_id: string }).venue_id !== auth.venueId) {
      return forbidden('tour does not belong to your venue')
    }
  }
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

function isFresh(generatedAt: string): boolean {
  const t = Date.parse(generatedAt)
  if (!Number.isFinite(t)) return false
  return Date.now() - t < CACHE_WINDOW_MS
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }
  const tourId = typeof body.tourId === 'string' ? body.tourId : null
  const force = body.force === true
  if (!tourId) return badRequest('tourId required')

  const authResolved = await resolveAuth(req, tourId)
  if (authResolved instanceof NextResponse) return authResolved

  const supabase = createServiceClient()

  if (!force) {
    const stored = await getStoredTourPrepBrief(tourId, { supabase })
    if (stored && isFresh(stored.generatedAt)) {
      return NextResponse.json({
        ok: true,
        cached: true,
        tourId,
        venueId: stored.venueId,
        weddingId: stored.weddingId,
        brief: stored.brief,
        promptVersion: stored.promptVersion,
        generatedAt: stored.generatedAt,
        cumulativeCostCents: stored.costCents,
      })
    }
  }

  try {
    const result = await generateTourPrepBrief({ tourId, supabase })
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, reason: result.reason },
        { status: 422 },
      )
    }
    return NextResponse.json({
      ok: true,
      cached: false,
      tourId: result.tourId,
      venueId: result.venueId,
      weddingId: result.weddingId,
      brief: result.brief,
      promptVersion: result.promptVersion,
      costCents: result.costCents,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[tour-prep-brief] route error:', message)
    return NextResponse.json(
      {
        ok: false,
        error: message,
        promptVersion: TOUR_PREP_BRIEF_PROMPT_VERSION,
      },
      { status: 500 },
    )
  }
}
