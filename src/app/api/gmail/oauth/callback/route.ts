/**
 * GET /api/gmail/oauth/callback
 *
 * OAuth redirect target (PROJECT-AUDIT-V2 GAP-13).
 *
 * Steps:
 *   1. Verify the HMAC-signed state token. Extract venueId + userId
 *      from the verified payload — the callback NEVER trusts a
 *      caller-supplied venueId.
 *   2. Exchange the authorization code for tokens.
 *   3. Fetch the connected Gmail address via oauth2.userinfo.get.
 *   4. Detect partial scope grants and surface the gap.
 *   5. Upsert a gmail_connections row keyed on (venue_id, email_address)
 *      so reconnecting the same Gmail UPDATEs the existing row.
 *   6. Redirect back to returnTo with ?gmail=connected (success) or
 *      ?gmail=error&reason=... (failure).
 */

import { NextRequest, NextResponse } from 'next/server'
import { OAuth2Client } from 'google-auth-library'
import { createServiceClient } from '@/lib/supabase/service'
import {
  verifyGmailOAuthState,
  safeReturnTo,
} from '@/lib/services/email/gmail-oauth-state'
import { GMAIL_OAUTH_SCOPES } from '@/app/api/gmail/oauth/start/route'
import { recordCounter } from '@/lib/observability/metrics'
import { redactError } from '@/lib/observability/redact'

function getRedirectUri(request: NextRequest): string {
  const envUri = process.env.GOOGLE_OAUTH_REDIRECT_URI
  if (envUri) return envUri
  const origin = new URL(request.url).origin
  return `${origin}/api/gmail/oauth/callback`
}

function redirectBack(
  request: NextRequest,
  returnTo: string,
  params: Record<string, string>,
): NextResponse {
  const target = new URL(returnTo || '/settings/gmail', request.url)
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
  return NextResponse.redirect(target)
}

/**
 * Compute which of the required scopes Google actually granted.
 * Returns the missing-scope list (empty when full coverage).
 */
function detectMissingScopes(grantedScope: string | null | undefined): string[] {
  if (!grantedScope) return [...GMAIL_OAUTH_SCOPES]
  const granted = new Set(grantedScope.split(/\s+/).filter(Boolean))
  return GMAIL_OAUTH_SCOPES.filter((s) => !granted.has(s))
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const stateParam = searchParams.get('state')
  const googleError = searchParams.get('error')

  // --- Verify state first; everything else hangs off it ---
  const stateResult = verifyGmailOAuthState(stateParam)
  if (!stateResult.ok) {
    const reason = `bad_state_${stateResult.reason}`
    await recordCounter('gmail_oauth_failed', {
      dimension: { stage: 'callback', reason: stateResult.reason },
    })
    // We don't have a verified returnTo, so fall back to the canonical
    // settings page on our own domain.
    return redirectBack(request, '/settings/gmail', { gmail: 'error', reason })
  }
  const { venueId, userId, returnTo: rawReturnTo } = stateResult.payload
  const returnTo = safeReturnTo(rawReturnTo)

  // --- Surface user-denied / Google-side errors ---
  if (googleError) {
    const reason = googleError === 'access_denied' ? 'access_denied' : 'google_error'
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason },
    })
    return redirectBack(request, returnTo, { gmail: 'error', reason })
  }

  if (!code) {
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason: 'no_code' },
    })
    return redirectBack(request, returnTo, { gmail: 'error', reason: 'no_code' })
  }

  // --- Env guard ---
  const clientId = process.env.GOOGLE_CLIENT_ID
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET
  if (!clientId || !clientSecret || clientSecret.startsWith('PASTE_')) {
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason: 'not_configured' },
    })
    return redirectBack(request, returnTo, { gmail: 'error', reason: 'not_configured' })
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
    const oauth2Client = new OAuth2Client({ clientId, clientSecret, redirectUri })
    const { tokens: exchanged } = await oauth2Client.getToken(code)
    tokens = exchanged
  } catch (err) {
    console.error('[gmail/oauth/callback] token exchange failed:', redactError(err))
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason: 'token_exchange_failed' },
    })
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'token_exchange_failed',
    })
  }

  if (!tokens.access_token) {
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason: 'no_access_token' },
    })
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'no_access_token',
    })
  }

  if (!tokens.refresh_token) {
    // prompt=consent should always yield a refresh token; if it
    // doesn't, the user has prior consent the OAuth server is reusing
    // — we can't poll Gmail without a refresh token, so surface it.
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason: 'no_refresh_token' },
    })
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'no_refresh_token',
    })
  }

  // --- Detect partial-scope grants ---
  const missingScopes = detectMissingScopes(tokens.scope)

  // --- Fetch the connected Gmail address via oauth2.userinfo.get ---
  // Direct Bearer fetch — equivalent to oauth2.userinfo.get but skips a
  // dependency on the discovery doc.
  let emailAddress = ''
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (res.ok) {
      const profile = (await res.json()) as { email?: string }
      if (profile.email) emailAddress = profile.email
    }
  } catch (err) {
    console.error('[gmail/oauth/callback] userinfo fetch failed:', redactError(err))
    // Non-fatal — fall through to the empty-emailAddress branch below.
  }

  if (!emailAddress) {
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason: 'userinfo_failed' },
    })
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'userinfo_failed',
    })
  }

  // --- Upsert connection row (idempotent on venue_id + email_address) ---
  const supabase = createServiceClient()

  // Check whether this specific email already has a row (re-auth case).
  // If so, preserve its existing is_primary value — we must not flip it
  // to false when a venue re-auths their primary connection.
  const { data: existingRow } = await supabase
    .from('gmail_connections')
    .select('id, is_primary')
    .eq('venue_id', venueId)
    .eq('email_address', emailAddress)
    .maybeSingle()

  // If this is a brand-new email (no existing row), check whether ANY
  // primary already exists for the venue so we can decide whether to
  // mark this one primary.
  let computedIsPrimary: boolean
  if (existingRow) {
    // Re-auth of an existing connection: preserve the stored is_primary.
    computedIsPrimary = existingRow.is_primary as boolean
  } else {
    // New email for this venue: primary only when no other primary exists.
    const { data: anyPrimary } = await supabase
      .from('gmail_connections')
      .select('id')
      .eq('venue_id', venueId)
      .eq('is_primary', true)
      .limit(1)
      .maybeSingle()
    computedIsPrimary = !anyPrimary
  }

  const gmailTokens = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date ?? Date.now() + 3600 * 1000,
    token_type: tokens.token_type ?? 'Bearer',
    scope: tokens.scope ?? '',
  }

  const errorMessage =
    missingScopes.length > 0
      ? `Partial scope grant — missing: ${missingScopes.join(', ')}`
      : null
  const status = missingScopes.length > 0 ? 'error' : 'active'

  const { error: upsertError } = await supabase
    .from('gmail_connections')
    .upsert(
      {
        venue_id: venueId,
        user_id: userId,
        email_address: emailAddress,
        gmail_tokens: gmailTokens,
        is_primary: computedIsPrimary,
        sync_enabled: missingScopes.length === 0,
        status,
        error_message: errorMessage,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'venue_id,email_address' },
    )

  if (upsertError) {
    console.error(
      '[gmail/oauth/callback] upsert failed:',
      redactError(upsertError.message),
    )
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason: 'db_write_failed' },
    })
    return redirectBack(request, returnTo, {
      gmail: 'error',
      reason: 'db_write_failed',
    })
  }

  // Mirror tokens into venue_config for legacy email-poll consumers
  // that still read venue_config.gmail_tokens.
  try {
    await supabase
      .from('venue_config')
      .update({ gmail_tokens: gmailTokens })
      .eq('venue_id', venueId)
  } catch (err) {
    // Non-fatal — gmail_connections is the source of truth now.
    console.warn('[gmail/oauth/callback] venue_config mirror failed:', redactError(err))
  }

  if (missingScopes.length > 0) {
    await recordCounter('gmail_oauth_failed', {
      venueId,
      dimension: { stage: 'callback', reason: 'partial_scope' },
    })
    return redirectBack(request, returnTo, {
      gmail: 'partial',
      email: emailAddress,
      missing_scopes: missingScopes.join(','),
    })
  }

  await recordCounter('gmail_oauth_complete', {
    venueId,
    dimension: { mode: 'real' },
  })
  return redirectBack(request, returnTo, {
    gmail: 'connected',
    email: emailAddress,
  })
}
