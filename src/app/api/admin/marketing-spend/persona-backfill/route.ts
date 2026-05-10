/**
 * Wave 6A — persona-overlay backfill endpoint.
 *
 * Walks every live attribution_events row in a venue and snapshots the
 * persona_label from couple_intel. Idempotent — re-running just
 * refreshes the snapshots.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * POST body:
 *   { venueId?: string, limit?: number }
 *
 * Returns: { processed, attached, skipped, errors }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { attachPersonaToVenue } from '@/lib/services/marketing-spend'

// Persona overlay backfill walks the venue's attribution_events. A
// 5000-row backfill takes ~30s in practice; pad for very large venues.
export const maxDuration = 300

interface PostBody {
  venueId?: string
  limit?: number
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
  if (auth.isDemo) return forbidden('demo cannot backfill persona overlay')
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

  const limit =
    typeof body.limit === 'number' && body.limit > 0
      ? Math.min(Math.floor(body.limit), 50_000)
      : 5000

  const result = await attachPersonaToVenue({ venueId, limit })

  return NextResponse.json({
    ok: true,
    venueId,
    processed: result.processed,
    attached: result.attached,
    skipped: result.skipped,
    errors: result.errors,
  })
}
