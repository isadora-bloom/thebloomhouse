/**
 * GET /api/auth/zoom
 *
 * Starts the Zoom OAuth flow. Builds the authorize URL with an HMAC-signed
 * state token so the callback can verify the request came from us.
 *
 * Query params:
 *   - returnTo: optional path to redirect back to after callback
 *               (e.g. /settings/zoom). Defaults to /settings/zoom.
 *
 * Auth: must be a platform user. Anonymous users are redirected to /login.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { ZOOM_SCOPES } from '@/lib/services/ingestion/zoom'
import {
  isOAuthStateConfigured,
  mintOAuthState,
} from '@/lib/services/integrations/oauth-state'

const ZOOM_OAUTH_AUTHORIZE = 'https://zoom.us/oauth/authorize'

function safeReturnTo(raw: string | null): string {
  if (!raw) return '/settings/zoom'
  if (!raw.startsWith('/')) return '/settings/zoom'
  if (raw.startsWith('//')) return '/settings/zoom'
  return raw
}

function getRedirectUri(request: NextRequest): string {
  const envUri = process.env.ZOOM_REDIRECT_URI
  if (envUri) return envUri
  const origin = new URL(request.url).origin
  return `${origin}/api/auth/zoom/callback`
}

/**
 * Build the signed state. S2 (2026-09-14 security audit): this used to
 * pick its key from ZOOM_STATE_SECRET → CRON_SECRET → NEXTAUTH_SECRET →
 * the literal 'bloom-zoom-state-dev-secret', which is in the repository.
 * A deploy missing all three env vars signed every Zoom state with a
 * public string. It now goes through the shared signer, which uses
 * STATE_SIGNING_SECRET and throws rather than falling back, and which
 * adds a single-use nonce.
 */
export function buildSignedState(payload: {
  venueId: string
  userId: string
  returnTo: string
}): string {
  return mintOAuthState({
    provider: 'zoom',
    venueId: payload.venueId,
    userId: payload.userId,
    returnTo: payload.returnTo,
  })
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const returnTo = safeReturnTo(searchParams.get('returnTo'))

  const auth = await getPlatformAuth()
  if (!auth) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set(
      'redirect',
      `/api/auth/zoom?returnTo=${encodeURIComponent(returnTo)}`
    )
    return NextResponse.redirect(loginUrl)
  }

  const clientId = process.env.ZOOM_CLIENT_ID
  if (!clientId) {
    const errorUrl = new URL(returnTo, request.url)
    errorUrl.searchParams.set('zoom', 'error')
    errorUrl.searchParams.set('reason', 'not_configured')
    return NextResponse.redirect(errorUrl)
  }

  if (!isOAuthStateConfigured()) {
    const errorUrl = new URL(returnTo, request.url)
    errorUrl.searchParams.set('zoom', 'error')
    errorUrl.searchParams.set('reason', 'state_signing_not_configured')
    return NextResponse.redirect(errorUrl)
  }

  const redirectUri = getRedirectUri(request)
  const state = buildSignedState({
    venueId: auth.venueId,
    userId: auth.userId,
    returnTo,
  })

  const authorizeUrl = new URL(ZOOM_OAUTH_AUTHORIZE)
  authorizeUrl.searchParams.set('response_type', 'code')
  authorizeUrl.searchParams.set('client_id', clientId)
  authorizeUrl.searchParams.set('redirect_uri', redirectUri)
  authorizeUrl.searchParams.set('state', state)
  // Zoom uses space-delimited scopes
  authorizeUrl.searchParams.set('scope', ZOOM_SCOPES.join(' '))

  return NextResponse.redirect(authorizeUrl.toString())
}
