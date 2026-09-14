import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import {
  readTikTokAdsEnv,
  exchangeTikTokCode,
  parseTikTokAdvertisers,
  persistTikTokConnection,
} from '@/lib/services/marketing-spend/connectors/tiktok-ads'
import { verifyAdOauthState } from '@/lib/services/marketing-spend/connectors/shared'

const SETTINGS_PATH = '/settings/integrations/tiktok-ads'

/**
 * GET /api/integrations/tiktok-ads/oauth/callback
 *
 * TikTok sends the coordinator back here with `auth_code` (not `code`,
 * which is the small difference that makes a copied handler quietly do
 * nothing) and the state token we minted.
 *
 * The token response carries the advertiser ids this grant reaches, so
 * the connection can be saved ready to read from without a second call.
 * The advertiser lookup afterwards is only for the display name and the
 * account currency; TikTok reports spend as a bare decimal, and assuming
 * dollars would mis-file every venue that does not use them.
 */
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const back = (query: string) =>
    NextResponse.redirect(new URL(`${SETTINGS_PATH}${query}`, request.nextUrl.origin))

  const sp = request.nextUrl.searchParams
  const authCode = sp.get('auth_code') ?? sp.get('code')
  const state = sp.get('state')
  const errorParam = sp.get('error')

  if (errorParam) return back(`?error=${encodeURIComponent(errorParam)}`)
  if (!authCode || !state) return back('?error=missing_code_or_state')

  const stateCheck = verifyAdOauthState(state, 'tiktok_ads')
  if (!stateCheck.ok) {
    return back(`?error=${encodeURIComponent(stateCheck.reason)}`)
  }
  if (stateCheck.venueId !== auth.venueId) return back('?error=venue_mismatch')
  // S2: bound to the user who started the flow, not only the venue.
  if (stateCheck.userId !== auth.userId) return back('?error=user_mismatch')

  const envCheck = readTikTokAdsEnv()
  if (!envCheck.ok) return back('?error=not_configured')

  try {
    const tokens = await exchangeTikTokCode({ env: envCheck.env, authCode })
    if (!tokens) return back('?error=exchange_failed')

    let advertiserName: string | null = null
    let currency: string | null = null
    const advertiserId = tokens.advertiserIds[0] ?? null
    if (advertiserId) {
      try {
        const params = new URLSearchParams({
          app_id: envCheck.env.appId,
          secret: envCheck.env.appSecret,
        })
        const resp = await fetch(
          `https://business-api.tiktok.com/open_api/v1.3/oauth2/advertiser/get/?${params}`,
          { headers: { 'Access-Token': tokens.accessToken } },
        )
        if (resp.ok) {
          const found = parseTikTokAdvertisers(await resp.json()).find(
            (a) => a.id === advertiserId,
          )
          advertiserName = found?.name ?? null
          currency = found?.currency ?? null
        }
      } catch {
        // Name and currency can be filled in later; the token is good.
      }
    }

    await persistTikTokConnection({
      venueId: auth.venueId,
      tokens,
      advertiserId,
      advertiserName,
      currency,
      connectedBy: auth.userId,
    })
    return back('?ok=1')
  } catch (err) {
    console.error('[tiktok-ads/oauth/callback]', err)
    return back('?error=exchange_failed')
  }
}
