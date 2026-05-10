/**
 * Wave 8 — GET /api/admin/external-signals/status?venueId=X
 *
 * Returns the per-signal health status for a venue. Calls
 * checkExternalSignalHealth which upserts the persistent rows in
 * external_signal_health AND returns the in-memory display payload.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
  serverError,
  assertCanAccessVenue,
} from '@/lib/api/auth-helpers'
import { checkExternalSignalHealth } from '@/lib/services/external-signals-config/health-check'

export const maxDuration = 30

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string
  if (cronAuth) {
    if (!venueIdParam) {
      return badRequest('CRON_SECRET path requires venueId query param')
    }
    venueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    const target = venueIdParam ?? auth.venueId
    if (!target) return badRequest('venueId required')
    const access = await assertCanAccessVenue(auth, target)
    if (!access.ok) return forbidden(access.reason)
    venueId = target
  }

  try {
    const signals = await checkExternalSignalHealth({ venueId })

    // Hero counts so the dashboard can render a tidy summary header.
    const counts = {
      total: signals.length,
      ready: signals.filter((s) => s.status === 'ready').length,
      config_missing: signals.filter((s) => s.status === 'config_missing').length,
      data_stale: signals.filter((s) => s.status === 'data_stale').length,
      error: signals.filter((s) => s.status === 'error').length,
      disabled: signals.filter((s) => s.status === 'disabled').length,
    }

    return NextResponse.json({
      ok: true,
      venueId,
      counts,
      signals,
      checkedAt: new Date().toISOString(),
    })
  } catch (err) {
    return serverError(err)
  }
}
