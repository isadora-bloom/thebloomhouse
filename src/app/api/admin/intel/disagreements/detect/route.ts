/**
 * Wave 17 — disagreement detect endpoint.
 *
 * POST /api/admin/intel/disagreements/detect
 *   body: { venueId?: string, weddingId?: string, narrate?: boolean }
 *
 * Auth (mirrors /api/admin/intel/external-matches/scan):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId or
 *     weddingId required in body.
 *   - else getPlatformAuth (coordinator UI). venueId comes from auth.
 *     Demo is forbidden.
 *
 * When narrate=true, the route also runs narrateDisagreements over the
 * venue's uncached active findings after detection completes. Default
 * is false — UI callers can fire-and-forget detection and let the
 * sweep narrate later.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { detectDisagreements } from '@/lib/services/disagreement/detect'
import { narrateDisagreements } from '@/lib/services/disagreement/narrate'

export const maxDuration = 300

interface PostBody {
  venueId?: string
  weddingId?: string
  narrate?: boolean
  limit?: number
}

interface Ctx {
  isCron: boolean
  venueId: string | null
  weddingId: string | null
  narrate: boolean
  limit: number
}

async function resolveAuth(
  req: NextRequest,
  body: PostBody,
): Promise<{ ctx: Ctx } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  const narrate = body.narrate === true
  const limit =
    typeof body.limit === 'number' && body.limit > 0 ? Math.min(500, body.limit) : 100
  if (cronAuth) {
    const venueId = typeof body.venueId === 'string' ? body.venueId : null
    const weddingId = typeof body.weddingId === 'string' ? body.weddingId : null
    if (!venueId && !weddingId) {
      return badRequest('CRON_SECRET path requires venueId or weddingId in body')
    }
    return {
      ctx: { isCron: true, venueId, weddingId, narrate, limit },
    }
  }
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot run disagreement detector')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  const weddingId = typeof body.weddingId === 'string' ? body.weddingId : null
  return {
    ctx: {
      isCron: false,
      venueId: auth.venueId,
      weddingId,
      narrate,
      limit,
    },
  }
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const resolved = await resolveAuth(req, body)
  if (resolved instanceof NextResponse) return resolved
  const { ctx } = resolved

  try {
    const detectResult = await detectDisagreements({
      venueId: ctx.weddingId ? undefined : ctx.venueId ?? undefined,
      weddingId: ctx.weddingId ?? undefined,
      limit: ctx.limit,
    })
    let narrateResult: Awaited<ReturnType<typeof narrateDisagreements>> | null = null
    if (ctx.narrate && ctx.venueId) {
      narrateResult = await narrateDisagreements({
        venueId: ctx.venueId,
        limit: Math.min(50, ctx.limit),
      })
    }
    return NextResponse.json({
      ok: true,
      venueId: ctx.venueId,
      weddingId: ctx.weddingId,
      detect: detectResult,
      narrate: narrateResult,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[disagreements-detect] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
