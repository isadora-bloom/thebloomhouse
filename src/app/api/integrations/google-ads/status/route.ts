import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  forbidden,
  serverError,
} from '@/lib/api/auth-helpers'
import {
  readGoogleAdsOauthEnv,
  getGoogleAdsConnection,
} from '@/lib/services/integrations/google-ads-oauth'
import { createServiceClient } from '@/lib/supabase/service'
import {
  connectorStatus,
  normaliseCustomerId,
} from '@/lib/services/marketing-spend/connectors/google-ads'

/**
 * GET /api/integrations/google-ads/status
 *
 * Returns env-var configuration state + the venue's current connection.
 * Never returns tokens.
 */
export async function GET(_request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  try {
    const envCheck = readGoogleAdsOauthEnv()
    const connection = await getGoogleAdsConnection(auth.venueId)
    return NextResponse.json({
      provider: 'google_ads',
      configured: envCheck.ok,
      missing: envCheck.ok ? [] : envCheck.missing,
      // W54: the same field the Meta and TikTok status routes return, so
      // the reallocation page can ask all three the same question.
      connectorStatus: await connectorStatus(auth.venueId),
      connection,
    })
  } catch (err) {
    return serverError(err)
  }
}

/**
 * POST /api/integrations/google-ads/status
 *
 * W54. Choose which Google Ads account this venue's spend is read from.
 * Migration 310 left customer_id nullable and nothing ever filled it, so
 * a venue could complete the grant and still have the connector refuse
 * with "no account chosen" forever. This is the missing half.
 *
 * The id is accepted in either form Google shows it, 123-456-7890 or
 * 1234567890, and stored as digits because that is what the API path
 * wants.
 */
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return forbidden('demo cannot change ad account settings')

  let body: { customerId?: unknown; customerName?: unknown } = {}
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest('expected a JSON body')
  }

  const customerId = normaliseCustomerId(body.customerId)
  if (!customerId || customerId.length < 8 || customerId.length > 15) {
    return badRequest(
      'customerId should be the Google Ads account id, with or without dashes',
    )
  }
  const customerName =
    typeof body.customerName === 'string' && body.customerName.trim() !== ''
      ? body.customerName.trim()
      : null

  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('google_ads_connections')
      .update({ customer_id: customerId, customer_name: customerName })
      .eq('venue_id', auth.venueId)
      .select('id')

    if (error) return serverError(error)
    if (!data || data.length === 0) {
      return badRequest('connect a Google Ads account before choosing one to read')
    }
    return NextResponse.json({ ok: true, customerId, customerName })
  } catch (err) {
    return serverError(err)
  }
}
