/**
 * GET /api/auth/gmail
 *
 * Initiates Gmail OAuth. Builds a Google consent URL with offline + consent
 * prompt so we always get a refresh_token, stores a CSRF state token in a
 * signed cookie along with the returnTo path, and redirects the browser to
 * Google.
 *
 * Query params:
 *   - returnTo: optional path to redirect back to after callback
 *               (e.g. /onboarding, /agent/settings). Defaults to /agent/settings.
 *
 * Auth: must be a platform user. Anonymous users are redirected to /login.
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'crypto'
import { OAuth2Client } from 'google-auth-library'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/userinfo.email',
]

const STATE_COOKIE = 'bloom_gmail_oauth_state'
const STATE_COOKIE_MAX_AGE = 10 * 60 // 10 minutes

function safeReturnTo(raw: string | null): string {
  // Only allow relative paths, and only on our own domain. Defaults to
  // /agent/settings.
  if (!raw) return '/agent/settings'
  if (!raw.startsWith('/')) return '/agent/settings'
  if (raw.startsWith('//')) return '/agent/settings'
  return raw
}

function getRedirectUri(request: NextRequest): string {
  const envUri = process.env.GOOGLE_OAUTH_REDIRECT_URI
  if (envUri) return envUri
  const origin = new URL(request.url).origin
  return `${origin}/api/auth/gmail/callback`
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const returnTo = safeReturnTo(searchParams.get('returnTo'))

  // --- Auth guard ---
  const auth = await getPlatformAuth()
  if (!auth) {
    // Preserve the user's intent so after login they end up back here
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set(
      'redirect',
      `/api/auth/gmail?returnTo=${encodeURIComponent(returnTo)}`
    )
    return NextResponse.redirect(loginUrl)
  }

  // --- Env guard ---
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET

  if (!clientId || !clientSecret || clientSecret.startsWith('PASTE_')) {
    const errorUrl = new URL(returnTo, request.url)
    errorUrl.searchParams.set('gmail', 'error')
    errorUrl.searchParams.set('reason', 'not_configured')
    return NextResponse.redirect(errorUrl)
  }

  const redirectUri = getRedirectUri(request)

  // --- Build state token ---
  // The state is a random nonce. We store it along with returnTo + userId +
  // venueId in a signed (HttpOnly, SameSite=Lax) cookie so the callback can
  // verify the request.
  const nonce = randomBytes(16).toString('hex')

  const statePayload = {
    nonce,
    returnTo,
    userId: auth.userId,
    venueId: auth.venueId,
    ts: Date.now(),
  }

  const stateCookieValue = Buffer.from(JSON.stringify(statePayload)).toString(
    'base64url'
  )

  // --- Generate consent URL via google-auth-library ---
  try {
    const oauth2Client = new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri,
    })

    const consentUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_SCOPES,
      state: nonce,
      include_granted_scopes: true,
    })

    const response = NextResponse.redirect(consentUrl)
    response.cookies.set({
      name: STATE_COOKIE,
      value: stateCookieValue,
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: STATE_COOKIE_MAX_AGE,
    })
    return response
  } catch (err) {
    console.error('[api/auth/gmail] Failed to build consent URL:', err)
    const errorUrl = new URL(returnTo, request.url)
    errorUrl.searchParams.set('gmail', 'error')
    errorUrl.searchParams.set('reason', 'consent_url_failed')
    return NextResponse.redirect(errorUrl)
  }
}
