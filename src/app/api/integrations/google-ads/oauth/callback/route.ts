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
const SETTINGS_PATH = '/settings/integrations/google-ads'

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  // W54: these redirects used to be bare paths. NextResponse.redirect
  // needs an absolute URL and throws on a relative one, so every error
  // branch here was itself a 500 rather than the settings page saying
  // what went wrong. Built against the request origin now.
  const back = (query: string) =>
    NextResponse.redirect(new URL(`${SETTINGS_PATH}${query}`, request.nextUrl.origin))

  const sp = request.nextUrl.searchParams
  const code = sp.get('code')
  const state = sp.get('state')
  const errorParam = sp.get('error')

  if (errorParam) return back(`?error=${encodeURIComponent(errorParam)}`)
  if (!code || !state) return back('?error=missing_code_or_state')

  const stateCheck = verifyOauthState(state)
  if (!stateCheck.ok) {
    return back(`?error=${encodeURIComponent(stateCheck.reason)}`)
  }
  if (stateCheck.venueId !== auth.venueId) return back('?error=venue_mismatch')
  // S2: the state is bound to the user who clicked Connect, not just the
  // venue. Two coordinators at one venue can no longer finish each
  // other's consent round trip.
  if (stateCheck.userId !== auth.userId) return back('?error=user_mismatch')

  const envCheck = readGoogleAdsOauthEnv()
  if (!envCheck.ok) return back('?error=not_configured')

  try {
    const tokens = await exchangeCodeForTokens({ env: envCheck.env, code })
    await persistTokens({
      venueId: auth.venueId,
      tokens,
      connectedBy: auth.userId,
    })
    return back('?ok=1')
  } catch (err) {
    console.error('[google-ads-oauth/callback]', err)
    return back('?error=exchange_failed')
  }
}
