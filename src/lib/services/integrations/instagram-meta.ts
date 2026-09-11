/**
 * Bloom House — Instagram (Meta) connection + Graph helpers.
 *
 * Wave 3, W28. Spec: HANDLE-IDENTITY-SPEC.md §4, the "Instagram DMs via
 * Meta Messaging API" row. Shape copied from google-ads-oauth.ts, which
 * is the repo's worked example of an env-gated OAuth connector that
 * refuses to half-ship: a `read*Env()` that names what is missing, an
 * HMAC state token signed with CRON_SECRET, a token exchange, and a
 * connection row nobody but the service role can read the secret from.
 *
 * WHAT THIS MODULE OWNS
 * =====================
 *   - reading the three env vars and saying which are missing
 *   - the OAuth roundtrip against Meta (authorize URL, code exchange,
 *     long-lived token, page + Instagram account discovery)
 *   - instagram_connections reads and writes (migration 401)
 *   - the X-Hub-Signature-256 check the webhook runs
 *   - the Graph lookup that turns an IGSID into a username
 *
 * WHAT IT DOES NOT OWN
 * ====================
 * Anything to do with signals. The webhook hands a raw message to
 * `ingestInstagramDm` in src/lib/services/ingestion/instagram-dm.ts and
 * that file owns the NormalizedSignal. Outbound replies are out of
 * scope entirely; see the note at the foot of instagram-dm.ts for where
 * they would plug in.
 *
 * SECRETS
 * =======
 * Three single global env vars, per the repo's current pattern (Twilio,
 * Calendly, Stripe all work this way). Per-venue secrets are parked.
 *
 *   INSTAGRAM_APP_ID       Meta app id
 *   INSTAGRAM_APP_SECRET   Meta app secret. Also the HMAC key Meta signs
 *                          every webhook body with.
 *   INSTAGRAM_VERIFY_TOKEN A string you invent. Meta echoes it back
 *                          during the GET handshake so we can prove the
 *                          subscription was set up by us.
 *
 * The one genuinely per-venue secret is the page access token, because
 * Meta mints it per Facebook Page. It lives on the connection row, held
 * either as an env-var NAME (page_token_env_key, preferred: nothing
 * secret in the database) or as the token itself.
 *
 * Until the env vars are set, every entry point returns a structured
 * "not configured" answer. Nothing throws, nothing 500s, and the
 * settings page renders the missing list.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { createHmac, randomUUID, timingSafeEqual } from 'crypto'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Graph API version. Pinned on purpose: Meta deprecates versions on a
 *  two-year clock and a floating version turns a working connector into
 *  a silent one. Bump deliberately. */
export const GRAPH_VERSION = 'v21.0'
export const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`

const OAUTH_DIALOG_URL = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`

/**
 * Permissions the Meta app must request. `instagram_manage_messages` is
 * the one that actually delivers DMs; the rest are what Meta requires to
 * discover which Page and Instagram account the operator is granting.
 */
export const REQUIRED_SCOPES = [
  'instagram_basic',
  'instagram_manage_messages',
  'pages_manage_metadata',
  'pages_show_list',
  'business_management',
] as const

export interface InstagramAppEnv {
  appId: string
  appSecret: string
  verifyToken: string
}

/**
 * Read the three app-level env vars. Returns the missing NAMES rather
 * than a boolean so the settings page can print them.
 */
export function readInstagramEnv():
  | { ok: true; env: InstagramAppEnv }
  | { ok: false; missing: string[]; env: null } {
  const appId = process.env.INSTAGRAM_APP_ID ?? ''
  const appSecret = process.env.INSTAGRAM_APP_SECRET ?? ''
  const verifyToken = process.env.INSTAGRAM_VERIFY_TOKEN ?? ''
  const missing: string[] = []
  if (!appId) missing.push('INSTAGRAM_APP_ID')
  if (!appSecret) missing.push('INSTAGRAM_APP_SECRET')
  if (!verifyToken) missing.push('INSTAGRAM_VERIFY_TOKEN')
  if (missing.length > 0) return { ok: false, missing, env: null }
  return { ok: true, env: { appId, appSecret, verifyToken } }
}

/** The redirect URI the Meta app must allowlist. Derived from the public
 *  app URL so a preview deployment and production do not fight over one
 *  hardcoded string. */
export function instagramRedirectUri(origin?: string | null): string {
  const base =
    origin ??
    process.env.NEXT_PUBLIC_APP_URL ??
    'http://localhost:3000'
  return `${base.replace(/\/+$/, '')}/api/integrations/instagram/oauth/callback`
}

/** The webhook URL the operator pastes into the Meta app dashboard. */
export function instagramWebhookUrl(origin?: string | null): string {
  const base =
    origin ??
    process.env.NEXT_PUBLIC_APP_URL ??
    'http://localhost:3000'
  return `${base.replace(/\/+$/, '')}/api/webhooks/instagram`
}

// ---------------------------------------------------------------------------
// Webhook verification
// ---------------------------------------------------------------------------

/**
 * GET handshake. Meta calls the webhook once with
 * `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` and expects
 * the challenge echoed back verbatim as plain text.
 *
 * Returns the challenge when the token matches, null otherwise. Constant
 * time compare because the verify token is a shared secret.
 */
export function checkVerifyHandshake(
  params: URLSearchParams,
  expectedToken: string,
): string | null {
  const mode = params.get('hub.mode')
  const token = params.get('hub.verify_token')
  const challenge = params.get('hub.challenge')
  if (mode !== 'subscribe') return null
  if (!token || !challenge || !expectedToken) return null
  const a = Buffer.from(token, 'utf8')
  const b = Buffer.from(expectedToken, 'utf8')
  if (a.length !== b.length) return null
  return timingSafeEqual(a, b) ? challenge : null
}

/**
 * POST signature. Meta signs the raw request body with the app secret and
 * sends `X-Hub-Signature-256: sha256=<hex>`.
 *
 * Verified against the EXACT bytes received, so the caller must read
 * `request.text()` before parsing. A missing header is a failure, not a
 * skip: the Calendly route skips when its secret is unset, but here the
 * route has already refused with 503 by the time we get called, so there
 * is no configured-but-unsigned case to tolerate.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !appSecret) return false
  const prefix = 'sha256='
  if (!signatureHeader.startsWith(prefix)) return false
  const provided = signatureHeader.slice(prefix.length).trim()
  if (!/^[0-9a-f]+$/i.test(provided)) return false
  const expected = createHmac('sha256', appSecret)
    .update(rawBody, 'utf8')
    .digest('hex')
  const providedBuf = Buffer.from(provided.toLowerCase(), 'hex')
  const expectedBuf = Buffer.from(expected, 'hex')
  if (providedBuf.length !== expectedBuf.length) return false
  return timingSafeEqual(providedBuf, expectedBuf)
}

// ---------------------------------------------------------------------------
// OAuth state (anti-CSRF for the roundtrip)
// ---------------------------------------------------------------------------
//
// Same shape as google-ads-oauth.ts: no table for transient state, an
// HMAC over `${venueId}:${timestamp}:${nonce}` keyed on CRON_SECRET,
// base64url encoded, valid for ten minutes.

const STATE_TTL_MS = 10 * 60 * 1000

export function mintInstagramState(venueId: string): string {
  const secret = process.env.CRON_SECRET ?? ''
  if (!secret) throw new Error('CRON_SECRET missing — cannot sign OAuth state')
  const payload = `${venueId}:${Date.now()}:${randomUUID()}`
  const signature = createHmac('sha256', secret).update(payload).digest('hex')
  return Buffer.from(`${payload}:${signature}`).toString('base64url')
}

export function verifyInstagramState(
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
// OAuth roundtrip
// ---------------------------------------------------------------------------

export function buildInstagramAuthorizeUrl(args: {
  env: InstagramAppEnv
  redirectUri: string
  state: string
}): string {
  const params = new URLSearchParams({
    client_id: args.env.appId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: REQUIRED_SCOPES.join(','),
    state: args.state,
  })
  return `${OAUTH_DIALOG_URL}?${params.toString()}`
}

interface GraphError {
  error?: { message?: string; type?: string; code?: number }
}

async function graphJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, { method: 'GET' })
  const text = await resp.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Graph returned non-JSON (${resp.status}): ${text.slice(0, 200)}`)
  }
  const err = (parsed as GraphError).error
  if (!resp.ok || err) {
    throw new Error(
      `Graph ${resp.status}: ${err?.message ?? text.slice(0, 200)}`,
    )
  }
  return parsed as T
}

/** Short-lived user token from the OAuth code. */
export async function exchangeCodeForUserToken(args: {
  env: InstagramAppEnv
  redirectUri: string
  code: string
}): Promise<string> {
  const params = new URLSearchParams({
    client_id: args.env.appId,
    client_secret: args.env.appSecret,
    redirect_uri: args.redirectUri,
    code: args.code,
  })
  const data = await graphJson<{ access_token?: string }>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
  )
  if (!data.access_token) throw new Error('Graph returned no access_token')
  return data.access_token
}

/** Swap the short-lived user token for the sixty-day one. Page tokens
 *  derived from a long-lived user token do not expire, which is what we
 *  want for a background webhook. */
export async function exchangeForLongLivedUserToken(args: {
  env: InstagramAppEnv
  shortLivedToken: string
}): Promise<{ token: string; expiresInSeconds: number | null }> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: args.env.appId,
    client_secret: args.env.appSecret,
    fb_exchange_token: args.shortLivedToken,
  })
  const data = await graphJson<{ access_token?: string; expires_in?: number }>(
    `${GRAPH_BASE}/oauth/access_token?${params.toString()}`,
  )
  if (!data.access_token) throw new Error('Graph returned no long-lived token')
  return {
    token: data.access_token,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : null,
  }
}

export interface DiscoveredPage {
  pageId: string
  pageName: string | null
  pageToken: string
  igBusinessId: string | null
  igUsername: string | null
}

/**
 * List the Pages the operator granted and, for each, the linked
 * Instagram professional account. We take the first Page that HAS an
 * Instagram account, because a venue has one. When several do, the
 * caller is told so it can say "pick one" rather than guessing.
 */
export async function discoverPages(userToken: string): Promise<DiscoveredPage[]> {
  const params = new URLSearchParams({
    access_token: userToken,
    fields: 'id,name,access_token,instagram_business_account{id,username}',
  })
  const data = await graphJson<{
    data?: Array<{
      id?: string
      name?: string
      access_token?: string
      instagram_business_account?: { id?: string; username?: string }
    }>
  }>(`${GRAPH_BASE}/me/accounts?${params.toString()}`)
  const rows = data.data ?? []
  const out: DiscoveredPage[] = []
  for (const row of rows) {
    if (!row.id || !row.access_token) continue
    out.push({
      pageId: row.id,
      pageName: row.name ?? null,
      pageToken: row.access_token,
      igBusinessId: row.instagram_business_account?.id ?? null,
      igUsername: row.instagram_business_account?.username ?? null,
    })
  }
  return out
}

/**
 * Subscribe the Page to the `messages` field so Meta starts delivering.
 * Best effort: an operator can also tick this in the app dashboard, and
 * a failure here must not lose the connection we just established.
 */
export async function subscribePageToMessages(args: {
  pageId: string
  pageToken: string
}): Promise<{ ok: boolean; error: string | null }> {
  try {
    const resp = await fetch(
      `${GRAPH_BASE}/${encodeURIComponent(args.pageId)}/subscribed_apps`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          subscribed_fields: 'messages,messaging_postbacks',
          access_token: args.pageToken,
        }).toString(),
      },
    )
    if (!resp.ok) {
      const text = await resp.text()
      return { ok: false, error: `subscribe ${resp.status}: ${text.slice(0, 200)}` }
    }
    return { ok: true, error: null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---------------------------------------------------------------------------
// Sender lookup
// ---------------------------------------------------------------------------

export interface InstagramSenderProfile {
  /** Instagram handle, raw as Meta returns it. The caller normalises. */
  username: string | null
  /** Display name on the profile, when Meta returns one. */
  name: string | null
}

/**
 * Resolve an IGSID (the opaque scoped id Meta puts in sender.id) to a
 * username and display name.
 *
 * Returns nulls rather than throwing on any failure, because the caller's
 * rule is absolute: if the lookup fails, keep the IGSID in raw_payload
 * and leave handles null. A guessed handle is worse than no handle, and
 * this one feeds a deterministic match stage.
 */
export async function lookupInstagramSender(args: {
  igsid: string
  pageToken: string
  /** Injected in tests. Defaults to global fetch; no network in unit tests. */
  fetchImpl?: typeof fetch
}): Promise<InstagramSenderProfile> {
  const doFetch = args.fetchImpl ?? fetch
  const params = new URLSearchParams({
    fields: 'name,username',
    access_token: args.pageToken,
  })
  try {
    const resp = await doFetch(
      `${GRAPH_BASE}/${encodeURIComponent(args.igsid)}?${params.toString()}`,
      { method: 'GET' },
    )
    if (!resp.ok) {
      console.warn(
        `[instagram] sender lookup failed (${resp.status}) for igsid ${args.igsid}`,
      )
      return { username: null, name: null }
    }
    const body = (await resp.json()) as { username?: unknown; name?: unknown }
    return {
      username: typeof body.username === 'string' && body.username ? body.username : null,
      name: typeof body.name === 'string' && body.name ? body.name : null,
    }
  } catch (err) {
    console.warn(
      '[instagram] sender lookup threw (non-fatal):',
      err instanceof Error ? err.message : err,
    )
    return { username: null, name: null }
  }
}

// ---------------------------------------------------------------------------
// Connection persistence (migration 401)
// ---------------------------------------------------------------------------

export type InstagramConnectionStatus = 'pending' | 'connected' | 'error' | 'revoked'

/** The safe projection. Never carries the page token. */
export interface InstagramConnection {
  id: string
  venueId: string
  igBusinessId: string | null
  igUsername: string | null
  pageId: string | null
  pageName: string | null
  /** Name of the env var holding the token, when that route is used. */
  pageTokenEnvKey: string | null
  /** True when a token is reachable, by either route. Never the token. */
  hasToken: boolean
  status: InstagramConnectionStatus
  statusReason: string | null
  connectedAt: string | null
  lastEventAt: string | null
  lastErrorAt: string | null
  lastErrorMessage: string | null
}

interface ConnectionRow {
  id: string
  venue_id: string
  ig_business_id: string | null
  ig_username: string | null
  page_id: string | null
  page_name: string | null
  page_token_env_key: string | null
  page_access_token?: string | null
  status: string
  status_reason: string | null
  connected_at: string | null
  last_event_at: string | null
  last_error_at: string | null
  last_error_message: string | null
}

const SAFE_COLUMNS =
  'id, venue_id, ig_business_id, ig_username, page_id, page_name, ' +
  'page_token_env_key, status, status_reason, connected_at, ' +
  'last_event_at, last_error_at, last_error_message'

const TOKEN_COLUMNS = `${SAFE_COLUMNS}, page_access_token`

function toStatus(raw: string): InstagramConnectionStatus {
  if (raw === 'connected' || raw === 'error' || raw === 'revoked') return raw
  return 'pending'
}

function rowToConnection(row: ConnectionRow): InstagramConnection {
  const envKey = row.page_token_env_key
  const hasToken = Boolean(
    (envKey && process.env[envKey]) || row.page_access_token,
  )
  return {
    id: row.id,
    venueId: row.venue_id,
    igBusinessId: row.ig_business_id,
    igUsername: row.ig_username,
    pageId: row.page_id,
    pageName: row.page_name,
    pageTokenEnvKey: envKey,
    hasToken,
    status: toStatus(row.status),
    statusReason: row.status_reason,
    connectedAt: row.connected_at,
    lastEventAt: row.last_event_at,
    lastErrorAt: row.last_error_at,
    lastErrorMessage: row.last_error_message,
  }
}

/** Read one venue's connection. Safe projection; no token. */
export async function getInstagramConnection(
  venueId: string,
): Promise<InstagramConnection | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('instagram_connections')
    .select(TOKEN_COLUMNS)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error || !data) return null
  return rowToConnection(data as unknown as ConnectionRow)
}

/**
 * Webhook routing: Instagram business account id to venue. The unique
 * partial index on ig_business_id makes this at most one row, and a
 * connection in 'revoked' state is treated as absent so a disconnect
 * actually stops ingestion.
 */
export async function findConnectionByIgBusinessId(
  igBusinessId: string,
): Promise<{ connection: InstagramConnection; pageToken: string | null } | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('instagram_connections')
    .select(TOKEN_COLUMNS)
    .eq('ig_business_id', igBusinessId)
    .maybeSingle()
  if (error || !data) return null
  const row = data as unknown as ConnectionRow
  if (toStatus(row.status) === 'revoked') return null
  return {
    connection: rowToConnection(row),
    pageToken: resolvePageToken(row),
  }
}

/** Env-var name first, stored token second. Null when neither resolves. */
function resolvePageToken(row: ConnectionRow): string | null {
  if (row.page_token_env_key) {
    const fromEnv = process.env[row.page_token_env_key]
    if (fromEnv) return fromEnv
  }
  return row.page_access_token ?? null
}

export interface SaveConnectionArgs {
  venueId: string
  igBusinessId: string | null
  igUsername: string | null
  pageId: string | null
  pageName: string | null
  pageAccessToken?: string | null
  pageTokenEnvKey?: string | null
  tokenExpiresAt?: string | null
  connectedBy?: string | null
  status?: InstagramConnectionStatus
  statusReason?: string | null
}

/** Upsert on venue_id. One connection per venue, per migration 401. */
export async function saveInstagramConnection(
  args: SaveConnectionArgs,
): Promise<InstagramConnection> {
  const supabase = createServiceClient()
  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('instagram_connections')
    .upsert(
      {
        venue_id: args.venueId,
        ig_business_id: args.igBusinessId,
        ig_username: args.igUsername,
        page_id: args.pageId,
        page_name: args.pageName,
        page_access_token: args.pageAccessToken ?? null,
        page_token_env_key: args.pageTokenEnvKey ?? null,
        token_expires_at: args.tokenExpiresAt ?? null,
        status: args.status ?? 'connected',
        status_reason: args.statusReason ?? null,
        connected_by: args.connectedBy ?? null,
        connected_at: now,
        last_error_at: null,
        last_error_message: null,
        updated_at: now,
      },
      { onConflict: 'venue_id' },
    )
    .select(TOKEN_COLUMNS)
    .single()
  if (error) throw new Error(`instagram_connections upsert failed: ${error.message}`)
  return rowToConnection(data as unknown as ConnectionRow)
}

/** Operator pressed Disconnect. We keep the row for the audit trail and
 *  drop the token, because a revoked connection that still holds a
 *  credential is a trap. */
export async function disconnectInstagram(venueId: string): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('instagram_connections')
    .update({
      status: 'revoked',
      status_reason: 'disconnected by operator',
      page_access_token: null,
      token_expires_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('venue_id', venueId)
  if (error) throw new Error(`instagram disconnect failed: ${error.message}`)
}

/** Stamped by the webhook on every accepted message. Fire and forget:
 *  a failed heartbeat must never cost us the message. */
export async function markInstagramEvent(venueId: string): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('instagram_connections')
    .update({ last_event_at: new Date().toISOString() })
    .eq('venue_id', venueId)
  if (error) {
    console.warn('[instagram] last_event_at stamp failed:', error.message)
  }
}

export async function markInstagramError(
  venueId: string,
  message: string,
): Promise<void> {
  const supabase = createServiceClient()
  const { error } = await supabase
    .from('instagram_connections')
    .update({
      status: 'error',
      status_reason: 'graph_call_failed',
      last_error_at: new Date().toISOString(),
      last_error_message: message.slice(0, 500),
    })
    .eq('venue_id', venueId)
  if (error) {
    console.warn('[instagram] error stamp failed:', error.message)
  }
}
