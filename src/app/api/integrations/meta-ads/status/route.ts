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
  readMetaAdsEnv,
  connectorStatus,
} from '@/lib/services/marketing-spend/connectors/meta-ads'

/**
 * GET  /api/integrations/meta-ads/status  reads what the settings page shows.
 * POST /api/integrations/meta-ads/status  chooses which ad account to read.
 *
 * Never returns a token. The select names its columns, which is also
 * what stops an authenticated client tripping the column grant on
 * access_token.
 */

const PUBLIC_COLUMNS =
  'id, ad_account_id, ad_account_name, business_id, status, ' +
  'status_reason, connected_at, last_synced_at, last_error_at, ' +
  'last_error_message'

export async function GET(_request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  try {
    const envCheck = readMetaAdsEnv()
    const supabase = createServiceClient()
    const { data } = await supabase
      .from('meta_ads_connections')
      .select(PUBLIC_COLUMNS)
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    return NextResponse.json({
      provider: 'meta_ads',
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

  let body: { adAccountId?: unknown; adAccountName?: unknown } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest('expected a JSON body')
  }

  const raw = typeof body.adAccountId === 'string' ? body.adAccountId.trim() : ''
  const adAccountId = raw.replace(/^act_/, '')
  if (!/^\d{5,20}$/.test(adAccountId)) {
    return badRequest(
      'adAccountId should be the numeric ad account id, with or without the act_ prefix',
    )
  }
  const adAccountName =
    typeof body.adAccountName === 'string' && body.adAccountName.trim() !== ''
      ? body.adAccountName.trim()
      : null

  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('meta_ads_connections')
      .update({ ad_account_id: adAccountId, ad_account_name: adAccountName })
      .eq('venue_id', auth.venueId)
      .select('id')

    if (error) return serverError(error)
    if (!data || data.length === 0) {
      return badRequest('connect a Meta Ads account before choosing one to read')
    }
    return NextResponse.json({ ok: true, adAccountId, adAccountName })
  } catch (err) {
    return serverError(err)
  }
}
