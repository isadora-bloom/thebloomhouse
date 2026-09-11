import { NextRequest, NextResponse } from 'next/server'
import {
  badRequest,
  getPlatformAuth,
  unauthorized,
} from '@/lib/api/auth-helpers'
import {
  buildInstagramAuthorizeUrl,
  instagramRedirectUri,
  mintInstagramState,
  readInstagramEnv,
} from '@/lib/services/integrations/instagram-meta'

/**
 * GET /api/integrations/instagram/oauth/start
 *
 * Wave 3, W28. Begins the Meta OAuth flow for Instagram DMs.
 *
 *   1. Operator visits /settings/integrations/instagram
 *   2. Presses Connect, which sends the browser here
 *   3. We mint a CSRF-safe state token (HMAC of venueId + timestamp +
 *      nonce, keyed on CRON_SECRET) and redirect to Meta's consent dialog
 *   4. Meta returns the operator to /oauth/callback with code + state
 *
 * Returns 503 with the missing env-var names when the app credentials
 * are not set, which is what the settings page renders as its
 * not-configured state. It never redirects into a broken Meta dialog.
 */
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  if (auth.isDemo) return badRequest('demo cannot connect Instagram')

  const envCheck = readInstagramEnv()
  if (!envCheck.ok) {
    return NextResponse.json(
      {
        error: 'instagram_not_configured',
        missing: envCheck.missing,
        message:
          'Instagram DMs need the Meta app credentials set in Vercel. ' +
          'See the setup steps on /settings/integrations/instagram.',
      },
      { status: 503 },
    )
  }

  const state = mintInstagramState(auth.venueId)
  const url = buildInstagramAuthorizeUrl({
    env: envCheck.env,
    redirectUri: instagramRedirectUri(request.nextUrl.origin),
    state,
  })
  return NextResponse.redirect(url, 302)
}
