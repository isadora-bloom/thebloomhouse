/**
 * Wave 6B — persona × channel rollup recompute endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * POST body:
 *   { venueId?: string, windowDays?: number }
 *
 * Returns: { rolledUp, cellsWritten, windowsComputed, diagnostics }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { computePersonaChannelRollups } from '@/lib/services/intel/persona-channel-rollup'

// Recompute walks every spend row + attribution event in a venue across
// three windows. ~30s in practice for a venue with thousands of rows;
// pad for very large venues.
export const maxDuration = 300

interface PostBody {
  venueId?: string
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
  if (auth.isDemo) return forbidden('demo cannot recompute marketing ROI')
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

  const windowDays =
    typeof body.windowDays === 'number' &&
    body.windowDays > 0 &&
    body.windowDays <= 1000
      ? Math.floor(body.windowDays)
      : undefined

  try {
    const result = await computePersonaChannelRollups({ venueId, windowDays })
    return NextResponse.json({
      ok: true,
      venueId,
      rolledUp: result.rolledUp,
      cellsWritten: result.cellsWritten,
      windowsComputed: result.windowsComputed,
      diagnostics: result.diagnostics,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
