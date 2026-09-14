import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  forbidden,
  serverError,
} from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import {
  readTikTokAdsEnv,
  connectorStatus,
} from '@/lib/services/marketing-spend/connectors/tiktok-ads'

/**
 * GET  /api/integrations/tiktok-ads/status  reads what the settings page shows.
 * POST /api/integrations/tiktok-ads/status  chooses which advertiser to read.
 *
 * Never returns a token. The select names its columns, which is also
 * what stops an authenticated client tripping the column grant on
 * access_token.
 */

const PUBLIC_COLUMNS =
  'id, advertiser_id, advertiser_name, currency, status, status_reason, ' +
  'connected_at, last_synced_at, last_error_at, last_error_message'

export async function GET(_request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  try {
    const envCheck = readTikTokAdsEnv()
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('tiktok_ads_connections')
      .select(PUBLIC_COLUMNS)
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    return NextResponse.json({
      provider: 'tiktok_ads',
      configured: envCheck.ok,
      missing: envCheck.ok ? [] : envCheck.missing,
      connectorStatus: await connectorStatus(auth.venueId),
      connection: data ?? null,
    })
  } catch (err) {
    return serverError(err)
  }
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot change ad account settings')

  let body: { advertiserId?: unknown; advertiserName?: unknown } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest('expected a JSON body')
  }

  const advertiserId =
    typeof body.advertiserId === 'string' ? body.advertiserId.trim() : ''
  if (!/^\d{5,25}$/.test(advertiserId)) {
    return badRequest('advertiserId should be the numeric TikTok advertiser id')
  }
  const advertiserName =
    typeof body.advertiserName === 'string' && body.advertiserName.trim() !== ''
      ? body.advertiserName.trim()
      : null

  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('tiktok_ads_connections')
      .update({ advertiser_id: advertiserId, advertiser_name: advertiserName })
      .eq('venue_id', auth.venueId)
      .select('id')

    if (error) return serverError(error)
    if (!data || data.length === 0) {
      return badRequest('connect a TikTok Ads account before choosing one to read')
    }
    return NextResponse.json({ ok: true, advertiserId, advertiserName })
  } catch (err) {
    return serverError(err)
  }
}
