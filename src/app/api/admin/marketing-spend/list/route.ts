/**
 * Wave 6A — recent spend rows list endpoint.
 *
 * Auth (dual):
 *   - Authorization: Bearer ${CRON_SECRET} → ops path. venueId required.
 *   - else getPlatformAuth (coordinator UI). venueId from auth.
 *
 * GET query:
 *   { venueId?, channel?, fromDate?, toDate?, limit? }
 *
 * Returns: { rows: SpendRecord[], count }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import {
  getPlatformAuth,
  unauthorized,
  forbidden,
  badRequest,
} from '@/lib/api/auth-helpers'

export const maxDuration = 30

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

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
  if (auth.isDemo) return forbidden('demo cannot list spend rows')
  if (!auth.venueId) return badRequest('caller has no resolved venue')
  return { ctx: { isCron: false, venueId: auth.venueId } }
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const venueIdParam = url.searchParams.get('venueId')
  const channel = url.searchParams.get('channel')
  const fromDate = url.searchParams.get('fromDate')
  const toDate = url.searchParams.get('toDate')
  const limitRaw = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), MAX_LIMIT)
      : DEFAULT_LIMIT

  const authResolved = await resolveAuth(req, venueIdParam)
  if (authResolved instanceof NextResponse) return authResolved
  const { venueId } = authResolved.ctx

  const supabase = createServiceClient()
  let q = supabase
    .from('marketing_spend_records')
    .select(
      'id, venue_id, channel, campaign_id, campaign_name, spend_date, amount_cents, currency, ingested_at, ingested_by',
      { count: 'exact' },
    )
    .eq('venue_id', venueId)
    .order('spend_date', { ascending: false })
    .order('ingested_at', { ascending: false })
    .limit(limit)

  if (channel && typeof channel === 'string') q = q.eq('channel', channel)
  if (fromDate) q = q.gte('spend_date', fromDate)
  if (toDate) q = q.lte('spend_date', toDate)

  const { data, error, count } = await q

  if (error) {
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    venueId,
    count: count ?? 0,
    rows: data ?? [],
  })
}
