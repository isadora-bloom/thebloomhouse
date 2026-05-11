/**
 * Wave 17 — disagreement list endpoint.
 *
 * GET /api/admin/intel/disagreements/list
 *   ?venueId=X (cron path only — UI path uses auth's venueId)
 *   &axis=source|wedding_date|guest_count|budget|persona|close_prediction|name|crm_source|other
 *   &status=active|resolved|dismissed|investigating
 *   &minMagnitude=N
 *   &limit=N&offset=N
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import { listDisagreements } from '@/lib/services/disagreement/summary'
import { ALL_AXES, type DisagreementAxis, type DisagreementStatus } from '@/lib/services/disagreement/types'

export const maxDuration = 60

const ALLOWED_STATUSES: ReadonlyArray<DisagreementStatus> = [
  'active',
  'resolved',
  'dismissed',
  'investigating',
]

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

  const axisRaw = url.searchParams.get('axis')
  const axis =
    axisRaw && (ALL_AXES as ReadonlyArray<string>).includes(axisRaw)
      ? (axisRaw as DisagreementAxis)
      : undefined
  const statusRaw = url.searchParams.get('status')
  const status =
    statusRaw && (ALLOWED_STATUSES as ReadonlyArray<string>).includes(statusRaw)
      ? (statusRaw as DisagreementStatus)
      : undefined
  const minMagRaw = url.searchParams.get('minMagnitude')
  const minMagnitude = minMagRaw ? Math.max(0, Number(minMagRaw)) : undefined
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 50
  const offsetRaw = url.searchParams.get('offset')
  const offset = offsetRaw ? Math.max(0, Number(offsetRaw)) : 0

  try {
    const result = await listDisagreements(venueId, {
      axis,
      status,
      minMagnitude,
      limit,
      offset,
    })
    return NextResponse.json({
      ok: true,
      venueId,
      count: result.rows.length,
      hasMore: result.hasMore,
      rows: result.rows,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
