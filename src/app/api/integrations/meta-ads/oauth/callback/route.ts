import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import {
  readMetaAdsEnv,
  exchangeMetaCode,
  extendMetaToken,
  parseMetaAdAccounts,
  persistMetaConnection,
} from '@/lib/services/marketing-spend/connectors/meta-ads'
import { verifyAdOauthState } from '@/lib/services/marketing-spend/connectors/shared'

const SETTINGS_PATH = '/settings/integrations/meta-ads'

/**
 * GET /api/integrations/meta-ads/oauth/callback
 *
 * Meta sends the coordinator back here after they grant access.
 *
 *   ?code=...   the one-time code
 *   ?state=...  the signed token minted by /start
 *   ?error=...  when they decline
 *
 * The exchange runs server-side. Meta's first token lasts about an hour,
 * so it is immediately traded for the long-lived one and only that is
 * stored. We also ask which ad accounts the grant can see and save the
 * first as a sensible default, which is right for the great majority of
 * venues who have exactly one; the settings page lets them change it.
 *
 * Nothing about the token is ever put in the response.
 */
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const back = (query: string) =>
    NextResponse.redirect(new URL(`${SETTINGS_PATH}${query}`, request.nextUrl.origin))

  const sp = request.nextUrl.searchParams
  const code = sp.get('code')
  const state = sp.get('state')
  const errorParam = sp.get('error')

  if (errorParam) return back(`?error=${encodeURIComponent(errorParam)}`)
  if (!code || !state) return back('?error=missing_code_or_state')

  const stateCheck = verifyAdOauthState(state, 'meta_ads')
  if (!stateCheck.ok) {
    return back(`?error=${encodeURIComponent(stateCheck.reason)}`)
  }
  if (stateCheck.venueId !== auth.venueId) return back('?error=venue_mismatch')
  // S2: bound to the user who started the flow, not only the venue.
  if (stateCheck.userId !== auth.userId) return back('?error=user_mismatch')

  const envCheck = readMetaAdsEnv()
  if (!envCheck.ok) return back('?error=not_configured')

  try {
    const shortLived = await exchangeMetaCode({ env: envCheck.env, code })
    const longLived = await extendMetaToken({
      env: envCheck.env,
      token: shortLived.access_token,
    })

    // Which ad accounts this grant reaches. A failure here is not fatal:
    // the token is good, the account can be picked on the settings page.
    let accountId: string | null = null
    let accountName: string | null = null
    let businessId: string | null = null
    try {
      const resp = await fetch(
        `https://graph.facebook.com/v21.0/me/adaccounts?fields=account_id,name,business&access_token=${encodeURIComponent(longLived.access_token)}`,
      )
      if (resp.ok) {
        const accounts = parseMetaAdAccounts(await resp.json())
        if (accounts.length > 0) {
          accountId = accounts[0].id
          accountName = accounts[0].name
          businessId = accounts[0].businessId
        }
      }
    } catch {
      // Leave the account unset; the settings page asks for it.
    }

    await persistMetaConnection({
      venueId: auth.venueId,
      token: longLived,
      adAccountId: accountId,
      adAccountName: accountName,
      businessId,
      connectedBy: auth.userId,
    })
    return back('?ok=1')
  } catch (err) {
    console.error('[meta-ads/oauth/callback]', err)
    return back('?error=exchange_failed')
  }
}
