import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  serverError,
} from '@/lib/api/auth-helpers'
import {
  readGoogleAdsOauthEnv,
  getGoogleAdsConnection,
} from '@/lib/services/integrations/google-ads-oauth'

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
      configured: envCheck.ok,
      missing: envCheck.ok ? [] : envCheck.missing,
      connection,
    })
  } catch (err) {
    return serverError(err)
  }
}
