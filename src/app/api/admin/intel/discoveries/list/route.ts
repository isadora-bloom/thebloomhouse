/**
 * Wave 7A — discoveries list endpoint.
 *
 * GET /api/admin/intel/discoveries/list?venueId=X&status=Y&category=Z&limit=N
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId param required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * Returns paged list of recent discoveries.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { listDiscoveries } from '@/lib/services/intel/discovery/engine'

export const maxDuration = 60

const STATUS_VALUES: ReadonlyArray<string> = [
  'pending',
  'in_progress',
  'validated',
  'refuted',
  'dismissed',
]

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')

  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  let venueId: string | null = null
  if (cronAuth) {
    if (!venueIdParam) {
      return badRequest('CRON_SECRET path requires venueId param')
    }
    venueId = venueIdParam
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()
    if (!auth.venueId) return badRequest('caller has no resolved venue')
    venueId = auth.venueId
  }

  const statusRaw = url.searchParams.get('status')
  const status =
    statusRaw && STATUS_VALUES.includes(statusRaw) ? statusRaw : undefined
  const categoryRaw = url.searchParams.get('category')
  const category =
    categoryRaw && categoryRaw.length > 0 ? categoryRaw : undefined
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 200

  try {
    const discoveries = await listDiscoveries(venueId, {
      status,
      category,
      limit,
    })
    return NextResponse.json({
      ok: true,
      venueId,
      count: discoveries.length,
      discoveries,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
