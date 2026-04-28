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
import { createHmac } from 'crypto'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { ZOOM_SCOPES } from '@/lib/services/zoom'

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

function getStateSecret(): string {
  // Reuse CRON_SECRET if available; fall back to NEXTAUTH_SECRET, then to a
  // dev-only constant. Either of the env vars is fine — we only need a
  // stable per-deployment secret.
  return (
    process.env.ZOOM_STATE_SECRET ||
    process.env.CRON_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    'bloom-zoom-state-dev-secret'
  )
}

/**
 * Build a state string of the form `<payload-b64url>.<sig-b64url>` where
 * payload is JSON({ venueId, userId, returnTo, ts }) signed with HMAC-SHA256.
 */
export function buildSignedState(payload: {
  venueId: string
  userId: string
  returnTo: string
  ts: number
}): string {
  const json = JSON.stringify(payload)
  const payloadB64 = Buffer.from(json, 'utf-8').toString('base64url')
  const sig = createHmac('sha256', getStateSecret()).update(payloadB64).digest('base64url')
  return `${payloadB64}.${sig}`
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

  const redirectUri = getRedirectUri(request)
  const state = buildSignedState({
    venueId: auth.venueId,
    userId: auth.userId,
    returnTo,
    ts: Date.now(),
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
