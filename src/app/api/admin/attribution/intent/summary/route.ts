/**
 * Wave 16 — inquiry-intent aggregate summary endpoint.
 *
 * GET ?venueId=X — returns per-intent and per-channel intent counts
 * plus conversion-by-intent for the venue.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { getIntentSummary } from '@/lib/services/attribution-roles/intent-summary'

export const maxDuration = 60

interface AuthCtx {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  requestedVenueId: string | null,
): Promise<{ ctx: AuthCtx } | NextResponse> {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!requestedVenueId) {
      return badRequest('CRON_SECRET path requires venueId query param')
    }
    return { ctx: { isCron: true, venueId: requestedVenueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    if (!auth.venueId) return badRequest('demo session has no venue')
    return { ctx: { isCron: false, venueId: auth.venueId } }
  }
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  if (requestedVenueId && requestedVenueId !== auth.venueId) {
    return forbidden('venue does not belong to caller')
  }
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')

  const authResolved = await resolveAuth(req, requestedVenueId)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  try {
    const summary = await getIntentSummary(venueId)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intent-summary] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
