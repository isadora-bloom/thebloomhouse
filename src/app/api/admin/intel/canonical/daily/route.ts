/**
 * Canonical reader endpoint — getDailyList (Jun-4 checkpoint #3 / Phase 3.3).
 *
 * GET → the operator's daily landing list: needsReply / goingCold /
 * toursThisWeek / highIntent. Spine-only (couples + touchpoints + tours),
 * every threshold sourced. Additive migration target — see overview/route.ts.
 *
 * Auth mirrors /api/admin/intel/cohort-funnel.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { getDailyList } from '@/lib/intel/canonical'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

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

  try {
    const daily = await getDailyList(venueId)
    return NextResponse.json({ ok: true, daily })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[canonical/daily] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
