import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  readMetaAdsEnv,
  buildMetaAuthorizeUrl,
} from '@/lib/services/marketing-spend/connectors/meta-ads'
import { mintAdOauthState } from '@/lib/services/marketing-spend/connectors/shared'

/**
 * GET /api/integrations/meta-ads/oauth/start
 *
 * Begins the Meta Ads grant. The coordinator clicks Connect on
 * /settings/integrations/meta-ads, we mint an anti-forgery state token
 * (an HMAC of the venue id, a nonce and a timestamp, signed with
 * STATE_SIGNING_SECRET, single use, and good for ten minutes), and send
 * them to Meta.
 *
 * A 503 with the missing variable names comes back when the app
 * credentials are not provisioned yet, and the settings page shows that
 * list inline rather than a dead button.
 */
export async function GET(_request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('demo cannot connect Meta Ads')

  const envCheck = readMetaAdsEnv()
  if (!envCheck.ok) {
    return NextResponse.json(
      {
        error: 'meta_ads_not_configured',
        missing: envCheck.missing,
        message:
          'Meta Ads needs its app credentials set before a venue can connect. See the setup steps on /settings/integrations/meta-ads.',
      },
      { status: 503 },
    )
  }

  const state = mintAdOauthState(auth.venueId, auth.userId, 'meta_ads')
  return NextResponse.redirect(
    buildMetaAuthorizeUrl({ env: envCheck.env, state }),
    302,
  )
}
