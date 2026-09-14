import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import {
  discoverPages,
  exchangeCodeForUserToken,
  exchangeForLongLivedUserToken,
  instagramRedirectUri,
  readInstagramEnv,
  saveInstagramConnection,
  subscribePageToMessages,
  verifyInstagramState,
} from '@/lib/services/integrations/instagram-meta'
import { redactError } from '@/lib/observability/redact'

/**
 * GET /api/integrations/instagram/oauth/callback
 *
 * Wave 3, W28. Meta sends the operator back here after consent.
 *
 *   ?code=...   authorisation code
 *   ?state=...  the HMAC-signed token minted in /start
 *   ?error=...  when the operator denies consent
 *
 * What happens, in order:
 *   1. Verify state, and that its venue is the signed-in venue.
 *   2. Code to short-lived user token, then to the long-lived one. Page
 *      tokens derived from a long-lived user token do not expire, which
 *      is what a background webhook needs.
 *   3. List the operator's Pages and their linked Instagram accounts.
 *      Take the one Page that has an Instagram account. When more than
 *      one does we stop and say so rather than guess.
 *   4. Persist the connection and ask Meta to start delivering.
 *
 * Tokens never appear in the response or the redirect. Every failure
 * sends the operator back to the settings page with an error code in the
 * query string, so nothing dies on a blank screen.
 */
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const settings = new URL('/settings/integrations/instagram', request.url)
  const fail = (code: string) => {
    settings.searchParams.set('error', code)
    return NextResponse.redirect(settings)
  }

  const sp = request.nextUrl.searchParams
  const code = sp.get('code')
  const state = sp.get('state')
  const denied = sp.get('error')

  if (denied) return fail(denied)
  if (!code || !state) return fail('missing_code_or_state')

  const stateCheck = verifyInstagramState(state)
  if (!stateCheck.ok) return fail(stateCheck.reason.replace(/\s+/g, '_'))
  if (stateCheck.venueId !== auth.venueId) return fail('venue_mismatch')
  // S2: bound to the user who started the flow, not only the venue.
  if (stateCheck.userId !== auth.userId) return fail('user_mismatch')

  const envCheck = readInstagramEnv()
  if (!envCheck.ok) return fail('not_configured')

  try {
    const redirectUri = instagramRedirectUri(request.nextUrl.origin)
    const shortLived = await exchangeCodeForUserToken({
      env: envCheck.env,
      redirectUri,
      code,
    })
    const longLived = await exchangeForLongLivedUserToken({
      env: envCheck.env,
      shortLivedToken: shortLived,
    })

    const pages = await discoverPages(longLived.token)
    const withInstagram = pages.filter((p) => p.igBusinessId)

    if (withInstagram.length === 0) {
      await saveInstagramConnection({
        venueId: auth.venueId,
        igBusinessId: null,
        igUsername: null,
        pageId: pages[0]?.pageId ?? null,
        pageName: pages[0]?.pageName ?? null,
        pageAccessToken: null,
        connectedBy: auth.userId,
        status: 'error',
        statusReason:
          'No Instagram professional account is linked to any Page you granted. ' +
          'Link one in the Meta Business Suite, then connect again.',
      })
      return fail('no_instagram_account')
    }

    if (withInstagram.length > 1) {
      // Guessing which account a venue means is exactly the class of
      // mistake that makes a signal land on the wrong couple later.
      await saveInstagramConnection({
        venueId: auth.venueId,
        igBusinessId: null,
        igUsername: null,
        pageId: null,
        pageName: null,
        pageAccessToken: null,
        connectedBy: auth.userId,
        status: 'error',
        statusReason:
          `You granted ${withInstagram.length} Pages with Instagram accounts ` +
          `(${withInstagram.map((p) => p.igUsername ?? p.pageId).join(', ')}). ` +
          'Grant only the venue Page and connect again.',
      })
      return fail('multiple_instagram_accounts')
    }

    const page = withInstagram[0]
    await saveInstagramConnection({
      venueId: auth.venueId,
      igBusinessId: page.igBusinessId,
      igUsername: page.igUsername,
      pageId: page.pageId,
      pageName: page.pageName,
      pageAccessToken: page.pageToken,
      tokenExpiresAt: null,
      connectedBy: auth.userId,
      status: 'connected',
    })

    // Best effort. The operator can also tick the subscription in the
    // Meta app dashboard, and a failure here must not undo a connection
    // that otherwise worked.
    const sub = await subscribePageToMessages({
      pageId: page.pageId,
      pageToken: page.pageToken,
    })
    if (!sub.ok) {
      console.warn('[instagram-oauth/callback] page subscribe failed:', sub.error)
    }

    settings.searchParams.set('ok', '1')
    if (!sub.ok) settings.searchParams.set('warn', 'subscribe_failed')
    return NextResponse.redirect(settings)
  } catch (err) {
    console.error('[instagram-oauth/callback]', redactError(err))
    return fail(
      err instanceof Error
        ? err.message.slice(0, 120).replace(/\s+/g, '_')
        : 'exchange_failed',
    )
  }
}
