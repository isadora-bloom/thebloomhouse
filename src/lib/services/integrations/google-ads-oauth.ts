/**
 * Bloom House — Google Ads OAuth.
 *
 * Wave 6E follow-up. Closes the brand-search vs non-brand attribution
 * gap the TBH Report's coverage disclosure called out as the second-
 * biggest hole. GCLID values captured by the site pixel become real
 * keyword/match-type/campaign-name lookups once the venue grants
 * Google Ads read access.
 *
 * ARCHITECTURE
 * ============
 *
 * 1. Operator visits /settings/integrations/google-ads.
 * 2. Page shows "Connect" → calls /api/integrations/google-ads/oauth/start.
 * 3. /start mints a state token + redirects to Google's OAuth consent
 *    screen. Required Google Cloud setup is documented below.
 * 4. Google redirects back to /api/integrations/google-ads/oauth/callback
 *    with code + state. Callback exchanges code → tokens, lists the
 *    venue's Google Ads customers, persists the connection.
 * 5. The Google Ads spend connector (separate module, mostly built
 *    already at src/lib/services/marketing-spend/connectors/google-ads.ts)
 *    reads tokens via this module's `getValidAccessToken()` and pulls
 *    daily campaign + keyword data.
 *
 * REQUIRED GOOGLE CLOUD SETUP (one-time, on Isadora's side):
 *
 *   - Google Cloud project with the Google Ads API enabled.
 *   - OAuth 2.0 Client ID (Web application).
 *   - Authorized redirect URI: https://YOUR_BLOOM_DOMAIN/api/integrations/google-ads/oauth/callback
 *   - Google Ads developer token (the "developer_token" you apply for in
 *     the Google Ads console — initial approval is BASIC tier which is
 *     enough for OAuth + read-only access; PRODUCTION tier needed for
 *     write operations later).
 *
 * REQUIRED ENV VARS (set in Vercel):
 *
 *   GOOGLE_ADS_CLIENT_ID
 *   GOOGLE_ADS_CLIENT_SECRET
 *   GOOGLE_ADS_DEVELOPER_TOKEN
 *   GOOGLE_ADS_OAUTH_REDIRECT_URI  (full https URL pointing at the callback)
 *
 * Until all four are set, the start endpoint returns a configuration
 * error explaining what's missing. No surface ships in a half-configured
 * state.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { randomUUID } from 'crypto'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OAUTH_AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const REQUIRED_SCOPE = 'https://www.googleapis.com/auth/adwords'

export interface GoogleAdsOauthEnv {
  clientId: string
  clientSecret: string
  developerToken: string
  redirectUri: string
}

export function readGoogleAdsOauthEnv():
  | { ok: true; env: GoogleAdsOauthEnv }
  | { ok: false; missing: string[] } {
  const env: Partial<GoogleAdsOauthEnv> = {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    redirectUri: process.env.GOOGLE_ADS_OAUTH_REDIRECT_URI,
  }
  const missing: string[] = []
  if (!env.clientId) missing.push('GOOGLE_ADS_CLIENT_ID')
  if (!env.clientSecret) missing.push('GOOGLE_ADS_CLIENT_SECRET')
  if (!env.developerToken) missing.push('GOOGLE_ADS_DEVELOPER_TOKEN')
  if (!env.redirectUri) missing.push('GOOGLE_ADS_OAUTH_REDIRECT_URI')
  if (missing.length > 0) return { ok: false, missing }
  return { ok: true, env: env as GoogleAdsOauthEnv }
}

// ---------------------------------------------------------------------------
// State token (anti-CSRF for the OAuth roundtrip)
// ---------------------------------------------------------------------------
//
// We don't add a new table for transient state tokens. Encoded form is
// `${venueId}:${nonce}:${signature}` where signature = HMAC-SHA256 of
// `${venueId}:${nonce}` using CRON_SECRET (already shared between the
// app and the deploy environment). 10-minute validity enforced by
// embedding a unix timestamp in the nonce.

import { createHmac, timingSafeEqual } from 'crypto'

const STATE_TTL_MS = 10 * 60 * 1000

export function mintOauthState(venueId: string): string {
  const secret = process.env.CRON_SECRET ?? ''
  if (!secret) throw new Error('CRON_SECRET missing — cannot sign OAuth state')
  const nonce = `${Date.now()}:${randomUUID()}`
  const payload = `${venueId}:${nonce}`
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
  return Buffer.from(`${payload}:${signature}`).toString('base64url')
}

export function verifyOauthState(
  state: string,
): { ok: true; venueId: string } | { ok: false; reason: string } {
  const secret = process.env.CRON_SECRET ?? ''
  if (!secret) return { ok: false, reason: 'CRON_SECRET missing' }
  let decoded: string
  try {
    decoded = Buffer.from(state, 'base64url').toString('utf-8')
  } catch {
    return { ok: false, reason: 'invalid encoding' }
  }
  const parts = decoded.split(':')
  if (parts.length < 4) return { ok: false, reason: 'malformed state' }
  // Last segment is the signature; everything else is the payload.
  const signature = parts.pop() as string
  const payload = parts.join(':')
  const expected = createHmac('sha256', secret).update(payload).digest('hex')
  const sigBuf = Buffer.from(signature, 'hex')
  const expBuf = Buffer.from(expected, 'hex')
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    return { ok: false, reason: 'signature mismatch' }
  }
  const [venueId, tsStr] = parts
  const ts = Number(tsStr)
  if (!Number.isFinite(ts) || Date.now() - ts > STATE_TTL_MS) {
    return { ok: false, reason: 'state expired' }
  }
  return { ok: true, venueId }
}

// ---------------------------------------------------------------------------
// Authorize URL
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(args: {
  env: GoogleAdsOauthEnv
  state: string
}): string {
  const params = new URLSearchParams({
    client_id: args.env.clientId,
    redirect_uri: args.env.redirectUri,
    response_type: 'code',
    scope: REQUIRED_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // force refresh_token issuance
    state: args.state,
  })
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface OauthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
  token_type?: string
}

export async function exchangeCodeForTokens(args: {
  env: GoogleAdsOauthEnv
  code: string
}): Promise<OauthTokenResponse> {
  const body = new URLSearchParams({
    code: args.code,
    client_id: args.env.clientId,
    client_secret: args.env.clientSecret,
    redirect_uri: args.env.redirectUri,
    grant_type: 'authorization_code',
  })
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Google token exchange failed (${resp.status}): ${text}`)
  }
  return (await resp.json()) as OauthTokenResponse
}

export async function refreshAccessToken(args: {
  env: GoogleAdsOauthEnv
  refreshToken: string
}): Promise<OauthTokenResponse> {
  const body = new URLSearchParams({
    refresh_token: args.refreshToken,
    client_id: args.env.clientId,
    client_secret: args.env.clientSecret,
    grant_type: 'refresh_token',
  })
  const resp = await fetch(OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Google refresh failed (${resp.status}): ${text}`)
  }
  return (await resp.json()) as OauthTokenResponse
}

// ---------------------------------------------------------------------------
// Connection persistence
// ---------------------------------------------------------------------------

export interface GoogleAdsConnectionRow {
  id: string
  venueId: string
  customerId: string | null
  customerName: string | null
  status: 'pending' | 'connected' | 'error' | 'revoked'
  statusReason: string | null
  connectedAt: string | null
  lastUsedAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
}

interface GoogleAdsConnectionRowFromDb {
  id: string
  venue_id: string
  customer_id: string | null
  customer_name: string | null
  status: string
  status_reason: string | null
  connected_at: string | null
  last_used_at: string | null
  last_error_at: string | null
  last_error_message: string | null
}

function rowToConnection(
  row: GoogleAdsConnectionRowFromDb,
): GoogleAdsConnectionRow {
  return {
    id: row.id,
    venueId: row.venue_id,
    customerId: row.customer_id,
    customerName: row.customer_name,
    status:
      row.status === 'connected'
        ? 'connected'
        : row.status === 'error'
          ? 'error'
          : row.status === 'revoked'
            ? 'revoked'
            : 'pending',
    statusReason: row.status_reason,
    connectedAt: row.connected_at,
    lastUsedAt: row.last_used_at,
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
  }
}

export async function getGoogleAdsConnection(
  venueId: string,
): Promise<GoogleAdsConnectionRow | null> {
  const service = createServiceClient()
  const { data } = await service
    .from('google_ads_connections')
    .select(
      'id, venue_id, customer_id, customer_name, status, status_reason, connected_at, last_used_at, last_error_at, last_error_message',
    )
    .eq('venue_id', venueId)
    .maybeSingle()
  return data ? rowToConnection(data as GoogleAdsConnectionRowFromDb) : null
}

export interface PersistTokensArgs {
  venueId: string
  tokens: OauthTokenResponse
  connectedBy?: string | null
  customerId?: string | null
  customerName?: string | null
}

export async function persistTokens(
  args: PersistTokensArgs,
): Promise<GoogleAdsConnectionRow> {
  const service = createServiceClient()
  const expiresAt =
    args.tokens.expires_in && args.tokens.expires_in > 0
      ? new Date(Date.now() + args.tokens.expires_in * 1000).toISOString()
      : null
  const payload = {
    venue_id: args.venueId,
    access_token: args.tokens.access_token,
    refresh_token: args.tokens.refresh_token ?? null,
    access_token_expires_at: expiresAt,
    scope: args.tokens.scope ?? null,
    token_type: args.tokens.token_type ?? null,
    customer_id: args.customerId ?? null,
    customer_name: args.customerName ?? null,
    status: 'connected' as const,
    status_reason: null,
    connected_by: args.connectedBy ?? null,
    connected_at: new Date().toISOString(),
    last_used_at: new Date().toISOString(),
    last_error_at: null,
    last_error_message: null,
  }
  const { data, error } = await service
    .from('google_ads_connections')
    .upsert(payload, { onConflict: 'venue_id' })
    .select('*')
    .single()
  if (error) throw new Error(`persist tokens failed: ${error.message}`)
  return rowToConnection(data as GoogleAdsConnectionRowFromDb)
}

/**
 * Read the current access_token, refreshing if necessary. Server-side
 * only — never expose tokens to clients.
 */
export async function getValidAccessToken(
  venueId: string,
): Promise<string | null> {
  const envCheck = readGoogleAdsOauthEnv()
  if (!envCheck.ok) return null
  const service = createServiceClient()
  const { data } = await service
    .from('google_ads_connections')
    .select(
      'access_token, refresh_token, access_token_expires_at, status',
    )
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!data || data.status !== 'connected') return null
  const accessToken = data.access_token as string | null
  const refreshToken = data.refresh_token as string | null
  const expiresAt = data.access_token_expires_at as string | null
  // 60s skew tolerance.
  const expired =
    !expiresAt || Date.now() + 60_000 > new Date(expiresAt).getTime()
  if (!expired && accessToken) return accessToken
  if (!refreshToken) return null
  try {
    const refreshed = await refreshAccessToken({
      env: envCheck.env,
      refreshToken,
    })
    await persistTokens({
      venueId,
      tokens: {
        ...refreshed,
        // Refresh response often omits refresh_token; preserve the old one.
        refresh_token: refreshed.refresh_token ?? refreshToken,
      },
    })
    return refreshed.access_token
  } catch (err) {
    await service
      .from('google_ads_connections')
      .update({
        status: 'error',
        status_reason: 'refresh_failed',
        last_error_at: new Date().toISOString(),
        last_error_message:
          err instanceof Error ? err.message.slice(0, 500) : String(err),
      })
      .eq('venue_id', venueId)
    return null
  }
}
