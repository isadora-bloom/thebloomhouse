/**
 * Wave 6D — latest weekly digest endpoint.
 *
 * GET /api/admin/intel/marketing-loop/digest/latest?venueId=
 *
 * Returns the most recently generated digest for the venue + a list of
 * past digest periods (for the history dropdown).
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  getLatestDigest,
  listDigests,
} from '@/lib/services/marketing-spend/loop'

export const maxDuration = 30

interface AuthContext {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  bodyVenueId: string | null,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!bodyVenueId) {
      return badRequest('CRON_SECRET path requires venueId query param')
    }
    return { ctx: { isCron: true, venueId: bodyVenueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return forbidden('demo cannot read marketing digests')
  }
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  const authResolved = await resolveAuth(req, venueIdParam)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  try {
    const [latest, history] = await Promise.all([
      getLatestDigest(venueId),
      listDigests(venueId, { limit: 20 }),
    ])
    return NextResponse.json({
      ok: true,
      venueId,
      latest,
      history: history.map((h) => ({
        id: h.id,
        digest_period_start: h.digest_period_start,
        digest_period_end: h.digest_period_end,
        generated_at: h.generated_at,
      })),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
