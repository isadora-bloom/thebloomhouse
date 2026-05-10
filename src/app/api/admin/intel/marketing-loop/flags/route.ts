/**
 * Wave 6D — flags list endpoint.
 *
 * GET /api/admin/intel/marketing-loop/flags?venueId=&status=&severity=
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path; venueId required.
 *   - else getPlatformAuth (coordinator UI); venueId from auth.
 *
 * Returns: { ok, flags: [...] }
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'
import { listMarketingFlags } from '@/lib/services/marketing-spend/loop'

export const maxDuration = 30

const VALID_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'acknowledged',
  'actioned',
  'dismissed',
  'resolved',
])

const VALID_SEVERITIES: ReadonlySet<string> = new Set([
  'info',
  'warning',
  'critical',
])

interface AuthContext {
  isCron: boolean
  venueId: string
}

async function resolveAuth(
  req: NextRequest,
  bodyVenueId: string | null,
): Promise<{ ctx: AuthContext } | NextResponse> {
  const cronAuth =
    req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (cronAuth) {
    if (!bodyVenueId) {
      return badRequest('CRON_SECRET path requires venueId query param')
    }
    return { ctx: { isCron: true, venueId: bodyVenueId } }
  }

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) {
    return forbidden('demo cannot list marketing flags')
  }
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const statusParam = url.searchParams.get('status')
  const severityParam = url.searchParams.get('severity')

  const authResolved = await resolveAuth(req, venueIdParam)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const status =
    statusParam && VALID_STATUSES.has(statusParam) ? statusParam : undefined
  const severity =
    severityParam && VALID_SEVERITIES.has(severityParam)
      ? severityParam
      : undefined

  try {
    const flags = await listMarketingFlags(venueId, { status, severity })
    return NextResponse.json({ ok: true, venueId, flags })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
