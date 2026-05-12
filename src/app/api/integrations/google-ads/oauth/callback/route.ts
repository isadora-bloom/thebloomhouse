import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import {
  readGoogleAdsOauthEnv,
  verifyOauthState,
  exchangeCodeForTokens,
  persistTokens,
} from '@/lib/services/integrations/google-ads-oauth'

/**
 * GET /api/integrations/google-ads/oauth/callback
 *
 * Wave 6E follow-up. Google redirects the user here after consent.
 *
 *   ?code=...   from Google
 *   ?state=...  the HMAC-signed token we minted in /start
 *   ?error=...  when the user denies consent (we redirect with a hint)
 *
 * Token exchange runs server-side via the Node fetch. Tokens are
 * persisted to google_ads_connections via service-role. We do NOT
 * return the tokens in the response.
 *
 * Customer-ID listing (which Google Ads account this venue wants to
 * read) is intentionally deferred — first OAuth round persists tokens
 * + status='connected', and the customer-picker UI on /settings then
 * calls Google's customers:listAccessibleCustomers to populate the
 * dropdown. This keeps the OAuth round-trip fast.
 */
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const sp = request.nextUrl.searchParams
  const code = sp.get('code')
  const state = sp.get('state')
  const errorParam = sp.get('error')

  if (errorParam) {
    return NextResponse.redirect(
      `/settings/integrations/google-ads?error=${encodeURIComponent(errorParam)}`,
    )
  }
  if (!code || !state) {
    return NextResponse.redirect(
      '/settings/integrations/google-ads?error=missing_code_or_state',
    )
  }
  const stateCheck = verifyOauthState(state)
  if (!stateCheck.ok) {
    return NextResponse.redirect(
      `/settings/integrations/google-ads?error=${encodeURIComponent(stateCheck.reason)}`,
    )
  }
  if (stateCheck.venueId !== auth.venueId) {
    return NextResponse.redirect(
      '/settings/integrations/google-ads?error=venue_mismatch',
    )
  }

  const envCheck = readGoogleAdsOauthEnv()
  if (!envCheck.ok) {
    return NextResponse.redirect(
      '/settings/integrations/google-ads?error=not_configured',
    )
  }

  try {
    const tokens = await exchangeCodeForTokens({ env: envCheck.env, code })
    await persistTokens({
      venueId: auth.venueId,
      tokens,
      connectedBy: auth.userId,
    })
    return NextResponse.redirect('/settings/integrations/google-ads?ok=1')
  } catch (err) {
    console.error('[google-ads-oauth/callback]', err)
    return NextResponse.redirect(
      `/settings/integrations/google-ads?error=${encodeURIComponent(
        err instanceof Error ? err.message.slice(0, 200) : 'exchange_failed',
      )}`,
    )
  }
}
