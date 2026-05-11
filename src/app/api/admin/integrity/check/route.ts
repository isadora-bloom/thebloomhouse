/**
 * Wave 9 — GET /api/admin/integrity/check
 *
 * Runs the full data-integrity invariant set (not capped at the
 * detector's SAMPLE_LIMIT, because the admin page needs true counts —
 * the existing sweep caps samples for the anomaly_alerts payload, but
 * the count returned is the actual count after the underlying query
 * returns). Returns each invariant's count + meaning + a sample slice.
 *
 * Auth: getPlatformAuth coordinator path. CRON_SECRET supported for
 * ops.
 *
 * Query params:
 *   venueId  defaults to caller's venue
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { runDataIntegrityChecks } from '@/lib/services/data-integrity'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const requestedVenueId = url.searchParams.get('venueId')

  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string | null = null
  if (cronAuth) {
    if (!requestedVenueId) return badRequest('CRON_SECRET path requires venueId')
    venueId = requestedVenueId
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot run integrity check')
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = requestedVenueId ?? auth.venueId
    if (venueId !== auth.venueId) {
      return forbidden('cannot run integrity check on a venue you do not own')
    }
  }

  const sb = createServiceClient()
  const results = await runDataIntegrityChecks(sb, venueId)
  return NextResponse.json({
    ok: true,
    venueId,
    invariants: results,
    ranAt: new Date().toISOString(),
  })
}
