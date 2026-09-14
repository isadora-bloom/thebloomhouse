/**
 * GET /api/auth/zoom/callback
 *
 * Zoom OAuth redirect target. Verifies the HMAC-signed state, exchanges the
 * authorization code for tokens, fetches the connected user's profile, and
 * upserts a zoom_connections row keyed on (venue_id, zoom_user_id).
 *
 * Redirects back to the returnTo path with `?zoom=connected` on success or
 * `?zoom=error&reason=...` on failure.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { verifyOAuthState } from '@/lib/services/integrations/oauth-state'
import { redactError } from '@/lib/observability/redact'

interface StatePayload {
  venueId: string
  userId: string
  returnTo: string
}

function getRedirectUri(request: NextRequest): string {
  const envUri = process.env.ZOOM_REDIRECT_URI
  if (envUri) return envUri
  const origin = new URL(request.url).origin
  return `${origin}/api/auth/zoom/callback`
}

/**
 * S2 (2026-09-14 security audit). Signature, freshness and single-use
 * all live in the shared signer now; the only thing left here is the
 * shape of the payload this route expects. The window tightened from
 * fifteen minutes to the shared ten, and a replayed state is refused
 * outright rather than accepted a second time.
 */
function verifyState(state: string): StatePayload | null {
  const result = verifyOAuthState(state, 'zoom')
  if (!result.ok) {
    console.warn(`[zoom/callback] state rejected: ${result.reason}`)
    return null
  }
  const { venueId, userId, returnTo } = result.payload
  if (typeof returnTo !== 'string') return null
  return { venueId, userId, returnTo }
}

function redirectBack(
  request: NextRequest,
  returnTo: string,
  params: Record<string, string>
): NextResponse {
  const target = new URL(returnTo || '/settings/zoom', request.url)
  for (const [k, v] of Object.entries(params)) target.searchParams.set(k, v)
  return NextResponse.redirect(target)
}

interface ZoomTokenResponse {
  access_token?: string
  refresh_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

interface ZoomUserResponse {
  id?: string
  email?: string
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const stateParam = searchParams.get('state')
  const zoomError = searchParams.get('error')

  const state = stateParam ? verifyState(stateParam) : null
  const returnTo = state?.returnTo ?? '/settings/zoom'

  if (zoomError) {
    return redirectBack(request, returnTo, { zoom: 'error', reason: zoomError })
  }

  if (!state) {
    return redirectBack(request, returnTo, { zoom: 'error', reason: 'bad_state' })
  }

  if (!code) {
    return redirectBack(request, returnTo, { zoom: 'error', reason: 'no_code' })
  }

  // Re-verify the user matches the one who started the flow.
  const auth = await getPlatformAuth()
  if (!auth || auth.userId !== state.userId || auth.venueId !== state.venueId) {
    return redirectBack(request, returnTo, { zoom: 'error', reason: 'auth_mismatch' })
  }

  const clientId = process.env.ZOOM_CLIENT_ID
  const clientSecret = process.env.ZOOM_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    return redirectBack(request, returnTo, { zoom: 'error', reason: 'not_configured' })
  }

  const redirectUri = getRedirectUri(request)
  const basicAuth = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64')

  // --- Exchange code for tokens ---
  let tokens: ZoomTokenResponse
  try {
    const res = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: basicAuth,
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    })
    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(
        `[zoom/callback] token exchange failed (HTTP ${res.status}): ${errText.slice(0, 300)}`
      )
      return redirectBack(request, returnTo, {
        zoom: 'error',
        reason: 'token_exchange_failed',
      })
    }
    tokens = (await res.json()) as ZoomTokenResponse
  } catch (err) {
    console.error('[zoom/callback] token exchange threw:', redactError(err))
    return redirectBack(request, returnTo, {
      zoom: 'error',
      reason: 'token_exchange_failed',
    })
  }

  if (!tokens.access_token || !tokens.refresh_token) {
    return redirectBack(request, returnTo, {
      zoom: 'error',
      reason: 'incomplete_tokens',
    })
  }

  // --- Fetch user profile to get zoom_user_id + email ---
  let zoomUserId = ''
  let accountEmail: string | null = null
  try {
    const res = await fetch('https://api.zoom.us/v2/users/me', {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    })
    if (res.ok) {
      const profile = (await res.json()) as ZoomUserResponse
      zoomUserId = profile.id ?? ''
      accountEmail = profile.email ?? null
    } else {
      console.warn(`[zoom/callback] /users/me returned HTTP ${res.status}`)
    }
  } catch (err) {
    console.error('[zoom/callback] /users/me fetch failed:', redactError(err))
  }

  if (!zoomUserId) {
    // Without a stable zoom_user_id we can't honour the unique constraint.
    return redirectBack(request, returnTo, {
      zoom: 'error',
      reason: 'no_user_id',
    })
  }

  const expiresAt = new Date(
    Date.now() + (tokens.expires_in ?? 3600) * 1000
  ).toISOString()

  const supabase = createServiceClient()
  const { error: upsertError } = await supabase.from('zoom_connections').upsert(
    {
      venue_id: auth.venueId,
      zoom_user_id: zoomUserId,
      account_email: accountEmail,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: expiresAt,
      scope: tokens.scope ?? null,
      is_active: true,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'venue_id,zoom_user_id' }
  )

  if (upsertError) {
    console.error('[zoom/callback] zoom_connections upsert failed:', upsertError.message)
    return redirectBack(request, returnTo, {
      zoom: 'error',
      reason: 'db_write_failed',
    })
  }

  return redirectBack(request, returnTo, {
    zoom: 'connected',
    email: accountEmail ?? '',
  })
}
