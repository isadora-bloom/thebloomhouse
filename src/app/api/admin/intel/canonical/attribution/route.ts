/**
 * Canonical reader endpoint — getSourceAttribution (Jun-4 checkpoint #3).
 *
 * GET ?model=first_touch|last_touch|linear|time_decay&sinceDays=N
 *   → per-channel conversion / CAC / revenue-per-dollar, every cell an honest
 *   Distribution (null on a zero denominator, never a fake 0). Additive
 *   migration target — see overview/route.ts.
 *
 * Auth mirrors /api/admin/intel/cohort-funnel.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { getSourceAttribution, type AttributionModel } from '@/lib/intel/canonical'

export const maxDuration = 120

const MODELS: AttributionModel[] = ['first_touch', 'last_touch', 'linear', 'time_decay']
const MAX_SINCE_DAYS = 365 * 6

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

  const modelParam = url.searchParams.get('model')
  const model: AttributionModel = MODELS.includes(modelParam as AttributionModel)
    ? (modelParam as AttributionModel)
    : 'first_touch'

  let since: string | undefined
  const sinceDaysRaw = url.searchParams.get('sinceDays')
  if (sinceDaysRaw) {
    const n = Number(sinceDaysRaw)
    if (Number.isFinite(n) && n > 0) {
      const days = Math.min(Math.floor(n), MAX_SINCE_DAYS)
      since = new Date(Date.now() - days * 24 * 3600_000).toISOString()
    }
  }

  try {
    const attribution = await getSourceAttribution(venueId, {
      model,
      period: since ? { from: since, to: new Date().toISOString() } : undefined,
    })
    return NextResponse.json({ ok: true, attribution })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[canonical/attribution] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
