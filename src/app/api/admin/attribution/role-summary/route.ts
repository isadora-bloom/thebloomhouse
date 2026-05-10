/**
 * Wave 7B — channel-role aggregate summary endpoint.
 *
 * Anchor docs:
 *   - bloom-constitution.md
 *   - bloom-wave4-5-6-master-plan.md (Wave 7B)
 *
 * GET ?venueId=X — returns per-role and per-channel role counts for the
 * venue. Auth follows the standard CRON_SECRET / coordinator pattern.
 *
 * Reveals the headline insight: "X% of theknot.com leads are
 * validation, not acquisition." The byChannel array carries
 * acquisition_share_0_1 + validation_share_0_1 per channel so the
 * caller can render the split directly.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { getRoleSummary } from '@/lib/services/attribution-roles/role-summary'

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
    // Demo coordinator: must operate on the demo venue derived from the
    // auth context (not whatever they typed in the query string).
    if (!auth.venueId) return badRequest('demo session has no venue')
    return { ctx: { isCron: false, venueId: auth.venueId } }
  }
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  // Coordinator can only inspect their own venue.
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
    const summary = await getRoleSummary(venueId)
    return NextResponse.json({
      ok: true,
      ...summary,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[role-summary] error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
