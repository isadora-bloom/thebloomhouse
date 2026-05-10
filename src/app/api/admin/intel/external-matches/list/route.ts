/**
 * Wave 5C — external-matches list endpoint.
 *
 * GET /api/admin/intel/external-matches/list?venueId=X&signalType=Y&dismissed=false&actioned=false&weddingId=Z&limit=N
 *
 * Auth:
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId param required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * Returns paged list of recent matches.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  listIntelMatches,
  type IntelSignalType,
} from '@/lib/services/intel/external-match'

export const maxDuration = 60

const SIGNAL_TYPES: ReadonlyArray<IntelSignalType> = [
  'cultural_moment',
  'vendor_mention',
  'regional_benchmark',
  'competitor_mention',
  'cross_platform_handle',
]

function parseBool(v: string | null): boolean | undefined {
  if (v === null) return undefined
  if (v === 'true' || v === '1') return true
  if (v === 'false' || v === '0') return false
  return undefined
}

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

  const signalTypeRaw = url.searchParams.get('signalType')
  const signalType =
    signalTypeRaw && (SIGNAL_TYPES as ReadonlyArray<string>).includes(signalTypeRaw)
      ? (signalTypeRaw as IntelSignalType)
      : undefined
  const dismissed = parseBool(url.searchParams.get('dismissed'))
  const actioned = parseBool(url.searchParams.get('actioned'))
  const weddingId = url.searchParams.get('weddingId') ?? undefined
  const limitRaw = url.searchParams.get('limit')
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 100

  try {
    const matches = await listIntelMatches(venueId, {
      signalType,
      dismissed,
      actioned,
      weddingId,
      limit,
    })
    return NextResponse.json({
      ok: true,
      venueId,
      count: matches.length,
      matches,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
