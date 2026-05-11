/**
 * Wave 17 — disagreement summary endpoint.
 *
 * GET /api/admin/intel/disagreements/summary?venueId=X
 *
 * Returns:
 *   - totals by status (active / resolved / dismissed / investigating)
 *   - by-axis breakdown
 *   - top biggest-magnitude active findings (up to 12 by default)
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { getDisagreementSummary } from '@/lib/services/disagreement/summary'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string | null = null
  if (cronAuth) {
    if (!venueIdParam) return badRequest('CRON_SECRET path requires venueId param')
    venueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  const biggestLimitRaw = url.searchParams.get('biggestLimit')
  const biggestLimit = biggestLimitRaw
    ? Math.max(1, Math.min(50, Number(biggestLimitRaw)))
    : 12

  try {
    const summary = await getDisagreementSummary(venueId, { biggestLimit })
    return NextResponse.json({ ok: true, summary })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
