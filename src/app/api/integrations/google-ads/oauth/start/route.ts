import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
} from '@/lib/api/auth-helpers'
import {
  readGoogleAdsOauthEnv,
  mintOauthState,
  buildAuthorizeUrl,
} from '@/lib/services/integrations/google-ads-oauth'

/**
 * GET /api/integrations/google-ads/oauth/start
 *
 * Wave 6E follow-up. Begins the Google Ads OAuth flow.
 *
 * Coordinator-side flow:
 *   1. Visit /settings/integrations/google-ads
 *   2. Click "Connect Google Ads" → browser GETs this endpoint
 *   3. We mint a CSRF-safe state token (HMAC of venueId + nonce + ts
 *      using CRON_SECRET), build the Google authorize URL, redirect.
 *   4. Google sends the user back to /oauth/callback with code+state.
 *
 * Returns a 503 with structured error when env vars are missing — the
 * /settings page surfaces the missing-vars list inline.
 */
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('demo cannot connect Google Ads')

  const envCheck = readGoogleAdsOauthEnv()
  if (!envCheck.ok) {
    return NextResponse.json(
      {
        error: 'google_ads_not_configured',
        missing: envCheck.missing,
        message:
          'Google Ads OAuth requires environment variables set in Vercel. See the setup steps on /settings/integrations/google-ads.',
      },
      { status: 503 },
    )
  }

  const state = mintOauthState(auth.venueId)
  const url = buildAuthorizeUrl({ env: envCheck.env, state })
  return NextResponse.redirect(url, 302)
}
