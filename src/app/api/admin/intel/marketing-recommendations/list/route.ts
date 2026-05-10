/**
 * Wave 6C — marketing recommendations list endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * GET query:
 *   { venueId?, status? }
 *
 * Returns: { ok, recommendations: [...] }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { listMarketingRecommendations } from '@/lib/services/marketing-spend/recommendations'

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
    return forbidden('demo cannot list marketing recommendations')
  }
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'accepted',
  'declined',
  'in_progress',
  'completed',
  'invalidated',
])

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const statusParam = url.searchParams.get('status')

  const authResolved = await resolveAuth(req, venueIdParam)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const status =
    statusParam && VALID_STATUSES.has(statusParam) ? statusParam : undefined

  try {
    const recommendations = await listMarketingRecommendations(venueId, {
      status,
    })
    return NextResponse.json({
      ok: true,
      venueId,
      recommendations,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
