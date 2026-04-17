/**
 * GET /api/auth/gmail/callback
 *
 * OAuth redirect target. Google sends us here with `?code=...&state=...`
 * or `?error=...` if the user denied.
 *
 * Steps:
 *   1. Validate state against the signed cookie we set in /api/auth/gmail.
 *   2. Exchange the authorization code for tokens.
 *   3. Call userinfo to get the connected email address.
 *   4. Upsert a gmail_connections row for this venue. First connection for
 *      the venue is marked is_primary=true.
 *   5. Redirect to the returnTo path with ?gmail=connected (success) or
 *      ?gmail=error&reason=... (failure).
 */

import { NextRequest, NextResponse } from 'next/server'
import { OAuth2Client } from 'google-auth-library'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

const STATE_COOKIE = 'bloom_gmail_oauth_state'

interface StatePayload {
  nonce: string
  returnTo: string
  userId: string
  venueId: string
  ts: number
}

function getRedirectUri(request: NextRequest): string {
  const envUri = process.env.GOOGLE_OAUTH_REDIRECT_URI
  if (envUri) return envUri
  const origin = new URL(request.url).origin
  return `${origin}/api/auth/gmail/callback`
}

function readState(request: NextRequest): StatePayload | null {
  const raw = request.cookies.get(STATE_COOKIE)?.value
  if (!raw) return null
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf-8')
    const parsed = JSON.parse(decoded) as StatePayload
    if (
      !parsed ||
      typeof parsed.nonce !== 'string' ||
      typeof parsed.returnTo !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.venueId !== 'string' ||
      typeof parsed.ts !== 'number'
    ) {
      return null
    }
    // Expire stale state (> 15 minutes)
    if (Date.now() - parsed.ts > 15 * 60 * 1000) return null
    return parsed
  } catch {
    return null
  }
}

function redirectBack(
  request: NextRequest,
  returnTo: string,
  params: Record<string, string>
): NextResponse {
  const target = new URL(returnTo || '/agent/settings', request.url)
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
  const response = NextResponse.redirect(target)
  // Clear the state cookie regardless of outcome
  response.cookies.set({
    name: STATE_COOKIE,
    value: '',
    path: '/',
    maxAge: 0,
  })
  return response
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const stateParam = searchParams.get('state')
  const googleError = searchParams.get('error')

  // Recover state from cookie
  const state = readState(request)
  const returnTo = state?.returnTo ?? '/agent/settings'

  // --- Handle user denial / Google error ---
  if (googleError) {
    const reason = googleError === 'access_denied' ? 'access_denied' : 'google_error'
    return redirectBack(request, returnTo, { gmail: 'error', reason })
  }

  // --- Validate state cookie present and matches query ---
  if (!state || !stateParam || state.nonce !== stateParam) {
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'bad_state',
    })
  }

  if (!code) {
    return redirectBack(request, returnTo, { gmail: 'error', reason: 'no_code' })
  }

  // --- Re-verify auth still matches the user who initiated the flow ---
  const auth = await getPlatformAuth()
  if (!auth || auth.userId !== state.userId || auth.venueId !== state.venueId) {
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'auth_mismatch',
    })
  }

  // --- Env guard ---
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret || clientSecret.startsWith('PASTE_')) {
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'not_configured',
    })
  }

  const redirectUri = getRedirectUri(request)

  // --- Exchange code for tokens ---
  let tokens: {
    access_token?: string | null
    refresh_token?: string | null
    expiry_date?: number | null
    token_type?: string | null
    id_token?: string | null
    scope?: string | null
  }
  try {
    const oauth2Client = new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri,
    })
    const { tokens: exchanged } = await oauth2Client.getToken(code)
    tokens = exchanged
  } catch (err) {
    console.error('[api/auth/gmail/callback] token exchange failed:', err)
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'token_exchange_failed',
    })
  }

  if (!tokens.access_token) {
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'no_access_token',
    })
  }

  if (!tokens.refresh_token) {
    // This happens when the user previously granted consent to the same
    // client without revoking it. `prompt=consent` should prevent this, but
    // if it ever happens we surface a helpful error.
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'no_refresh_token',
    })
  }

  // --- Fetch the connected email address ---
  let emailAddress = 'unknown@gmail.com'
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (res.ok) {
      const profile = (await res.json()) as { email?: string }
      if (profile.email) emailAddress = profile.email
    }
  } catch (err) {
    console.error('[api/auth/gmail/callback] userinfo fetch failed:', err)
    // Non-fatal — we can still store the tokens
  }

  // --- Upsert gmail_connections row ---
  const supabase = createServiceClient()

  // Is there already a primary for this venue?
  const { data: existingPrimary } = await supabase
    .from('gmail_connections')
    .select('id')
    .eq('venue_id', auth.venueId)
    .eq('is_primary', true)
    .limit(1)
    .maybeSingle()

  const gmailTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
    token_type: tokens.token_type ?? 'Bearer',
  }

  const { error: upsertError } = await supabase
    .from('gmail_connections')
    .upsert(
      {
        venue_id: auth.venueId,
        user_id: auth.userId,
        email_address: emailAddress,
        gmail_tokens: gmailTokens,
        is_primary: !existingPrimary,
        label: 'Primary',
        sync_enabled: true,
        status: 'active',
        error_message: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'venue_id,email_address' }
    )

  if (upsertError) {
    console.error(
      '[api/auth/gmail/callback] failed to upsert connection:',
      upsertError.message
    )
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'db_write_failed',
    })
  }

  // Also mirror tokens into venue_config for legacy consumers
  try {
    await supabase
      .from('venue_config')
      .update({ gmail_tokens: gmailTokens })
      .eq('venue_id', auth.venueId)
  } catch {
    // Best-effort — new path reads gmail_connections
  }

  return redirectBack(request, returnTo, {
    gmail: 'connected',
    email: emailAddress,
  })
}
