import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  readTikTokAdsEnv,
  buildTikTokAuthorizeUrl,
} from '@/lib/services/marketing-spend/connectors/tiktok-ads'
import { mintAdOauthState } from '@/lib/services/marketing-spend/connectors/shared'

/**
 * GET /api/integrations/tiktok-ads/oauth/start
 *
 * Begins the TikTok Ads grant. Same shape as the Meta and Google flows:
 * mint an anti-forgery state token tied to this venue, then send the
 * coordinator to TikTok's authorisation portal.
 */
export async function GET(_request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('demo cannot connect TikTok Ads')

  const envCheck = readTikTokAdsEnv()
  if (!envCheck.ok) {
    return NextResponse.json(
      {
        error: 'tiktok_ads_not_configured',
        missing: envCheck.missing,
        message:
          'TikTok Ads needs its app credentials set before a venue can connect. See the setup steps on /settings/integrations/tiktok-ads.',
      },
      { status: 503 },
    )
  }

  const state = mintAdOauthState(auth.venueId)
  return NextResponse.redirect(
    buildTikTokAuthorizeUrl({ env: envCheck.env, state }),
    302,
  )
}
