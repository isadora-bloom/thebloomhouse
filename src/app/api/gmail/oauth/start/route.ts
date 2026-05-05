/**
 * GET /api/gmail/oauth/start
 *
 * Generates a Google OAuth consent URL with an HMAC-signed state
 * token (PROJECT-AUDIT-V2 GAP-13). The state carries venueId + userId
 * + nonce + timestamp; the callback verifies it and trusts NO
 * client-supplied venueId.
 *
 * Query params:
 *   - returnTo (optional): relative path to redirect back to after the
 *     callback completes. Defaults to /settings/gmail.
 *
 * Auth: requires a logged-in platform user. Anonymous users are sent
 * to /login with the original URL preserved.
 *
 * Required scopes (Google):
 *   - https://www.googleapis.com/auth/gmail.readonly
 *   - https://www.googleapis.com/auth/gmail.send
 *   - https://www.googleapis.com/auth/gmail.modify
 *   - openid email profile
 */

import { NextRequest, NextResponse } from 'next/server'
import { OAuth2Client } from 'google-auth-library'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { signGmailOAuthState, safeReturnTo } from '@/lib/services/gmail-oauth-state'
import { recordCounter } from '@/lib/observability/metrics'
import { redactError } from '@/lib/observability/redact'

export const GMAIL_OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'openid',
  'email',
  'profile',
]

function getRedirectUri(request: NextRequest): string {
  const envUri = process.env.GOOGLE_OAUTH_REDIRECT_URI
  if (envUri) return envUri
  const origin = new URL(request.url).origin
  return `${origin}/api/gmail/oauth/callback`
}

function redirectWithError(
  request: NextRequest,
  returnTo: string,
  reason: string,
): NextResponse {
  const target = new URL(returnTo, request.url)
  target.searchParams.set('gmail', 'error')
  target.searchParams.set('reason', reason)
  return NextResponse.redirect(target)
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const returnTo = safeReturnTo(searchParams.get('returnTo'))

  // --- Test-mode short-circuit ---
  // In dev only, with a special test header, bypass the Google round
  // trip so e2e tests can exercise state minting without real OAuth.
  // Production builds NEVER honour this branch.
  if (
    process.env.NODE_ENV !== 'production' &&
    searchParams.get('mock') === 'true' &&
    request.headers.get('x-bloom-test') === 'gmail-oauth'
  ) {
    const auth = await getPlatformAuth()
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    try {
      const state = signGmailOAuthState({
        venueId: auth.venueId,
        userId: auth.userId,
        returnTo,
      })
      await recordCounter('gmail_oauth_start', {
        venueId: auth.venueId,
        dimension: { mode: 'mock' },
      })
      return NextResponse.json({ ok: true, state, returnTo })
    } catch (err) {
      console.error('[gmail/oauth/start] mock state mint failed:', redactError(err))
      await recordCounter('gmail_oauth_failed', {
        venueId: auth.venueId,
        dimension: { stage: 'mock_state_mint' },
      })
      return NextResponse.json({ ok: false, reason: 'state_mint_failed' }, { status: 500 })
    }
  }

  // --- Auth guard ---
  const auth = await getPlatformAuth()
  if (!auth) {
    const loginUrl = new URL('/login', request.url)
    loginUrl.searchParams.set(
      'redirect',
      `/api/gmail/oauth/start?returnTo=${encodeURIComponent(returnTo)}`,
    )
    return NextResponse.redirect(loginUrl)
  }

  // --- Env guard ---
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret || clientSecret.startsWith('PASTE_')) {
    await recordCounter('gmail_oauth_failed', {
      venueId: auth.venueId,
      dimension: { stage: 'start', reason: 'not_configured' },
    })
    return redirectWithError(request, returnTo, 'not_configured')
  }
  if (!process.env.STATE_SIGNING_SECRET || process.env.STATE_SIGNING_SECRET.length < 16) {
    await recordCounter('gmail_oauth_failed', {
      venueId: auth.venueId,
      dimension: { stage: 'start', reason: 'state_secret_missing' },
    })
    return redirectWithError(request, returnTo, 'state_secret_missing')
  }

  // --- Mint signed state ---
  let stateToken: string
  try {
    stateToken = signGmailOAuthState({
      venueId: auth.venueId,
      userId: auth.userId,
      returnTo,
    })
  } catch (err) {
    console.error('[gmail/oauth/start] state mint failed:', redactError(err))
    await recordCounter('gmail_oauth_failed', {
      venueId: auth.venueId,
      dimension: { stage: 'start', reason: 'state_mint_failed' },
    })
    return redirectWithError(request, returnTo, 'state_mint_failed')
  }

  // --- Build Google consent URL ---
  const redirectUri = getRedirectUri(request)
  let consentUrl: string
  try {
    const oauth2Client = new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri,
    })
    consentUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: GMAIL_OAUTH_SCOPES,
      include_granted_scopes: true,
      state: stateToken,
    })
  } catch (err) {
    console.error('[gmail/oauth/start] consent url failed:', redactError(err))
    await recordCounter('gmail_oauth_failed', {
      venueId: auth.venueId,
      dimension: { stage: 'start', reason: 'consent_url_failed' },
    })
    return redirectWithError(request, returnTo, 'consent_url_failed')
  }

  await recordCounter('gmail_oauth_start', {
    venueId: auth.venueId,
    dimension: { mode: 'real' },
  })
  return NextResponse.redirect(consentUrl, { status: 302 })
}
