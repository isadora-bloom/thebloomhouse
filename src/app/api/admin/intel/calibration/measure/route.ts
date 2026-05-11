/**
 * Wave 18 — Calibration measure endpoint.
 *
 * POST /api/admin/intel/calibration/measure
 * Body: { venueId?: string, weddingId?: string, limit?: number }
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId optional;
 *     when omitted the sweep runs across every venue with recent
 *     snapshots.
 *   - else getPlatformAuth (coordinator UI). venueId is the caller's
 *     resolved venue; cross-venue measurement is forbidden.
 *
 * Returns: a MeasureOutcomesResult or a SweepResult depending on path.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { measureOutcomes } from '@/lib/services/calibration/measure-outcomes'
import { runCalibrationSweep } from '@/lib/services/calibration/sweep'

export const maxDuration = 300

interface PostBody {
  venueId?: string
  weddingId?: string
  limit?: number
  sweep?: boolean
}

export async function POST(req: NextRequest) {
  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    body = {}
  }

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`

  let venueId: string | null = null

  if (cronAuth) {
    venueId = typeof body.venueId === 'string' ? body.venueId : null
    if (body.sweep === true || !venueId) {
      // Full sweep path — no venue scoping.
      const result = await runCalibrationSweep({ limit: body.limit })
      return NextResponse.json(result)
    }
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (auth.isDemo) return forbidden('demo cannot run calibration measure')
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    if (body.venueId && body.venueId !== auth.venueId) {
      return forbidden('cannot measure for another venue')
    }
    venueId = auth.venueId
  }

  const result = await measureOutcomes({
    venueId: venueId ?? undefined,
    weddingId: typeof body.weddingId === 'string' ? body.weddingId : undefined,
    limit: typeof body.limit === 'number' ? body.limit : undefined,
  })
  return NextResponse.json({
    ok: result.ok,
    measuredCount: result.measured.length,
    skipped: result.skipped,
    reason: result.reason,
    measured: result.measured,
  })
}
