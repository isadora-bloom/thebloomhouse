import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  serverError,
  unauthorized,
} from '@/lib/api/auth-helpers'
import {
  getInstagramConnection,
  instagramRedirectUri,
  instagramWebhookUrl,
  readInstagramEnv,
  REQUIRED_SCOPES,
} from '@/lib/services/integrations/instagram-meta'

/**
 * GET /api/integrations/instagram/status
 *
 * Everything the settings page needs to render itself: whether the
 * server is configured, which env vars are missing if not, the venue's
 * connection, and the two URLs the operator has to paste into the Meta
 * app dashboard.
 *
 * Never returns a token. `hasToken` is a boolean derived server-side.
 */
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  try {
    const envCheck = readInstagramEnv()
    const connection = await getInstagramConnection(auth.venueId)
    const origin = request.nextUrl.origin
    return NextResponse.json({
      configured: envCheck.ok,
      missing: envCheck.ok ? [] : envCheck.missing,
      connection,
      setup: {
        webhookUrl: instagramWebhookUrl(origin),
        redirectUri: instagramRedirectUri(origin),
        scopes: [...REQUIRED_SCOPES],
        webhookFields: ['messages', 'messaging_postbacks'],
      },
    })
  } catch (err) {
    return serverError(err)
  }
}
