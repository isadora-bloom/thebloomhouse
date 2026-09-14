/**
 * TikTok Ads spend connector (W54).
 *
 * Replaces the stub that stood here since Wave 6A. Daily spend,
 * impressions, clicks and conversions per campaign, pulled from the
 * TikTok Business API and landed in `marketing_spend_records` next to
 * the rows the manual form writes.
 *
 * Like Meta, TikTok had no connection table and no grant flow, so this
 * file carries both: the authorise round trip, the token store
 * (migration 407, `tiktok_ads_connections`) and the reporting read.
 *
 * THE READ
 * ========
 *   GET business-api.tiktok.com/open_api/v1.3/report/integrated/get/
 *       ?advertiser_id=<id>
 *       &report_type=BASIC
 *       &data_level=AUCTION_CAMPAIGN
 *       &dimensions=["campaign_id","stat_time_day"]
 *       &metrics=["campaign_name","spend","impressions","clicks","conversion"]
 *       &start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *
 * with the token in an `Access-Token` header rather than an
 * Authorization one.
 *
 * THE TRAP WORTH KNOWING
 * ======================
 * TikTok answers HTTP 200 on failure and puts the real outcome in a
 * `code` field in the body: 0 is success, anything else is not. A reader
 * that only checks `resp.ok` sees a successful request with no rows in
 * it and reports zero spend, which reads exactly like a day nobody
 * advertised. So the parser here treats a non-zero `code` as a refusal,
 * not as an empty result.
 *
 * DATES AND CURRENCY
 * ==================
 * `stat_time_day` comes back as "2026-09-01 00:00:00", so the day is the
 * first ten characters. Spend comes back as a bare decimal with no
 * currency attached, so the currency is read from the advertiser record
 * at connect time and held on the connection row. Assuming dollars would
 * quietly mis-file every venue that does not use them.
 *
 * GOING LIVE IS AN OPERATOR STEP
 * ==============================
 * TIKTOK_ADS_APP_ID, TIKTOK_ADS_APP_SECRET and
 * TIKTOK_ADS_OAUTH_REDIRECT_URI, documented on
 * /settings/integrations/tiktok-ads and in .env.local.example.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  countDays,
  decimalToCents,
  markConnectionError,
  markConnectionSynced,
  readConnectionRow,
  resolveStoredToken,
  resolveWindow,
  statusFromConnection,
  syncRefusal,
  toCount,
  toDecimal,
  toTextOrNull,
  writeDailyMetrics,
  type AdSyncResult,
  type ConnectorStatus,
  type DailyCampaignMetric,
} from './shared'

const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3'
const AUTHORIZE_BASE = 'https://business-api.tiktok.com/portal/auth'

const CONNECTION_COLUMNS =
  'id, venue_id, advertiser_id, advertiser_name, currency, token_env_key, ' +
  'access_token, refresh_token, token_expires_at, ' +
  'refresh_token_expires_at, scope, status, status_reason, connected_at, ' +
  'last_synced_at, last_error_at, last_error_message'

/** Refresh the access token when it has less than this left. */
const TOKEN_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface TikTokAdsEnv {
  appId: string
  appSecret: string
  redirectUri: string
}

export function readTikTokAdsEnv():
  | { ok: true; env: TikTokAdsEnv }
  | { ok: false; missing: string[] } {
  const appId = process.env.TIKTOK_ADS_APP_ID
  const appSecret = process.env.TIKTOK_ADS_APP_SECRET
  const redirectUri = process.env.TIKTOK_ADS_OAUTH_REDIRECT_URI
  const missing: string[] = []
  if (!appId) missing.push('TIKTOK_ADS_APP_ID')
  if (!appSecret) missing.push('TIKTOK_ADS_APP_SECRET')
  if (!redirectUri) missing.push('TIKTOK_ADS_OAUTH_REDIRECT_URI')
  if (missing.length > 0) return { ok: false, missing }
  return {
    ok: true,
    env: {
      appId: appId as string,
      appSecret: appSecret as string,
      redirectUri: redirectUri as string,
    },
  }
}

export function buildTikTokAuthorizeUrl(args: {
  env: TikTokAdsEnv
  state: string
}): string {
  const params = new URLSearchParams({
    app_id: args.env.appId,
    redirect_uri: args.env.redirectUri,
    state: args.state,
  })
  return `${AUTHORIZE_BASE}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

export interface TikTokEnvelope<T> {
  ok: boolean
  code: number
  message: string
  data: T | null
}

/**
 * Unwrap TikTok's envelope. `code` 0 is success; everything else is a
 * refusal dressed as a 200. See the note at the top of this file.
 */
export function readTikTokEnvelope<T = Record<string, unknown>>(
  body: unknown,
): TikTokEnvelope<T> {
  const row = (body ?? {}) as {
    code?: unknown
    message?: unknown
    data?: unknown
  }
  const code = Number(row.code)
  const normalised = Number.isFinite(code) ? code : -1
  return {
    ok: normalised === 0,
    code: normalised,
    message: toTextOrNull(row.message) ?? '',
    data: (row.data as T | undefined) ?? null,
  }
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface TikTokTokenData {
  access_token?: unknown
  refresh_token?: unknown
  expires_in?: unknown
  refresh_token_expires_in?: unknown
  advertiser_ids?: unknown
  scope?: unknown
}

export interface TikTokTokens {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  refreshTokenExpiresAt: string | null
  advertiserIds: string[]
  scope: string | null
}

export function parseTikTokTokenResponse(
  body: unknown,
  now: number = Date.now(),
): TikTokTokens | null {
  const env = readTikTokEnvelope<TikTokTokenData>(body)
  if (!env.ok || !env.data) return null
  const accessToken = toTextOrNull(env.data.access_token)
  if (!accessToken) return null

  const seconds = (v: unknown): string | null => {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return null
    return new Date(now + n * 1000).toISOString()
  }

  const ids = Array.isArray(env.data.advertiser_ids)
    ? env.data.advertiser_ids
        .map((v) => toTextOrNull(v))
        .filter((v): v is string => v !== null)
    : []

  const scope = Array.isArray(env.data.scope)
    ? env.data.scope.map((v) => String(v)).join(',')
    : toTextOrNull(env.data.scope)

  return {
    accessToken,
    refreshToken: toTextOrNull(env.data.refresh_token),
    expiresAt: seconds(env.data.expires_in),
    refreshTokenExpiresAt: seconds(env.data.refresh_token_expires_in),
    advertiserIds: ids,
    scope,
  }
}

export async function exchangeTikTokCode(args: {
  env: TikTokAdsEnv
  authCode: string
  fetchImpl?: typeof fetch
}): Promise<TikTokTokens | null> {
  const doFetch = args.fetchImpl ?? fetch
  const resp = await doFetch(`${API_BASE}/oauth2/access_token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: args.env.appId,
      secret: args.env.appSecret,
      auth_code: args.authCode,
      grant_type: 'auth_code',
    }),
  })
  if (!resp.ok) return null
  return parseTikTokTokenResponse(await resp.json())
}

export async function refreshTikTokToken(args: {
  env: TikTokAdsEnv
  refreshToken: string
  fetchImpl?: typeof fetch
}): Promise<TikTokTokens | null> {
  const doFetch = args.fetchImpl ?? fetch
  const resp = await doFetch(`${API_BASE}/oauth2/refresh_token/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: args.env.appId,
      secret: args.env.appSecret,
      refresh_token: args.refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!resp.ok) return null
  return parseTikTokTokenResponse(await resp.json())
}

export function tiktokTokenNeedsRefresh(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!expiresAt) return false
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return false
  return at - now < TOKEN_REFRESH_WINDOW_MS
}

export interface TikTokAdvertiser {
  id: string
  name: string | null
  currency: string | null
}

export function parseTikTokAdvertisers(body: unknown): TikTokAdvertiser[] {
  const env = readTikTokEnvelope<{ list?: unknown }>(body)
  if (!env.ok || !env.data || !Array.isArray(env.data.list)) return []
  const out: TikTokAdvertiser[] = []
  for (const raw of env.data.list) {
    const row = raw as {
      advertiser_id?: unknown
      advertiser_name?: unknown
      currency?: unknown
    }
    const id = toTextOrNull(row.advertiser_id)
    if (!id) continue
    out.push({
      id,
      name: toTextOrNull(row.advertiser_name),
      currency: toTextOrNull(row.currency),
    })
  }
  return out
}

export interface PersistTikTokConnectionArgs {
  venueId: string
  tokens: TikTokTokens
  advertiserId?: string | null
  advertiserName?: string | null
  currency?: string | null
  connectedBy?: string | null
  supabase?: SupabaseClient
}

export async function persistTikTokConnection(
  args: PersistTikTokConnectionArgs,
): Promise<void> {
  const client = args.supabase ?? createServiceClient()
  const { error } = await client
    .from('tiktok_ads_connections')
    .upsert(
      {
        venue_id: args.venueId,
        access_token: args.tokens.accessToken,
        refresh_token: args.tokens.refreshToken,
        token_expires_at: args.tokens.expiresAt,
        refresh_token_expires_at: args.tokens.refreshTokenExpiresAt,
        scope: args.tokens.scope,
        advertiser_id:
          args.advertiserId ?? args.tokens.advertiserIds[0] ?? null,
        advertiser_name: args.advertiserName ?? null,
        currency: args.currency ?? null,
        status: 'connected',
        status_reason: null,
        connected_by: args.connectedBy ?? null,
        connected_at: new Date().toISOString(),
        last_error_at: null,
        last_error_message: null,
      },
      { onConflict: 'venue_id' },
    )
    .select('id')
  if (error) {
    throw new Error(`Saving the TikTok connection failed: ${error.message}`)
  }
}

export async function getValidTikTokToken(
  venueId: string,
  opts: { supabase?: SupabaseClient; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const envCheck = readTikTokAdsEnv()
  if (!envCheck.ok) return null

  const row = await readConnectionRow(
    'tiktok_ads',
    venueId,
    CONNECTION_COLUMNS,
    opts.supabase,
  )
  if (statusFromConnection(row) !== 'connected') return null

  const stored = resolveStoredToken(row)
  const expiresAt = (row?.token_expires_at as string | null) ?? null
  if (stored && !tiktokTokenNeedsRefresh(expiresAt)) return stored

  const refreshToken = toTextOrNull(row?.refresh_token)
  if (!refreshToken) return stored

  const refreshed = await refreshTikTokToken({
    env: envCheck.env,
    refreshToken,
    fetchImpl: opts.fetchImpl,
  })
  if (!refreshed) {
    await markConnectionError(
      'tiktok_ads',
      venueId,
      'refresh_failed',
      'TikTok would not issue a new token from the saved one.',
      opts.supabase,
    )
    return stored
  }

  await persistTikTokConnection({
    venueId,
    tokens: {
      ...refreshed,
      refreshToken: refreshed.refreshToken ?? refreshToken,
    },
    advertiserId: toTextOrNull(row?.advertiser_id),
    advertiserName: toTextOrNull(row?.advertiser_name),
    currency: toTextOrNull(row?.currency),
    supabase: opts.supabase,
  })
  return refreshed.accessToken
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function connectorStatus(
  venueId: string,
  supabase?: SupabaseClient,
): Promise<ConnectorStatus> {
  const row = await readConnectionRow(
    'tiktok_ads',
    venueId,
    CONNECTION_COLUMNS,
    supabase,
  )
  return statusFromConnection(row)
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** "2026-09-01 00:00:00" to "2026-09-01". Anything else is refused. */
export function tiktokStatDay(value: unknown): string | null {
  const text = toTextOrNull(value)
  if (!text) return null
  const day = text.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

/**
 * Parse a report response into one metric per campaign per day. Returns
 * an empty array on a non-zero `code`, and the caller checks the
 * envelope separately so a refusal is never read as a quiet day.
 */
export function parseTikTokReportResponse(
  body: unknown,
  currency = 'USD',
): DailyCampaignMetric[] {
  const env = readTikTokEnvelope<{ list?: unknown }>(body)
  if (!env.ok || !env.data || !Array.isArray(env.data.list)) return []

  const out: DailyCampaignMetric[] = []
  for (const raw of env.data.list) {
    const row = raw as {
      dimensions?: { campaign_id?: unknown; stat_time_day?: unknown }
      metrics?: {
        campaign_name?: unknown
        spend?: unknown
        impressions?: unknown
        clicks?: unknown
        conversion?: unknown
      }
    }
    const spendDate = tiktokStatDay(row.dimensions?.stat_time_day)
    if (!spendDate) continue

    out.push({
      spendDate,
      campaignId: toTextOrNull(row.dimensions?.campaign_id),
      campaignName: toTextOrNull(row.metrics?.campaign_name),
      amountCents: decimalToCents(row.metrics?.spend),
      impressions: toCount(row.metrics?.impressions),
      clicks: toCount(row.metrics?.clicks),
      conversions: toDecimal(row.metrics?.conversion),
      currency,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface TikTokAdsSyncInput {
  venueId: string
  since?: string
  until?: string
  lookbackDays?: number
  supabase?: SupabaseClient
  fetchImpl?: typeof fetch
}

export type TikTokAdsSyncResult = AdSyncResult

export function buildReportUrl(args: {
  advertiserId: string
  since: string
  until: string
}): string {
  const params = new URLSearchParams({
    advertiser_id: args.advertiserId,
    report_type: 'BASIC',
    data_level: 'AUCTION_CAMPAIGN',
    dimensions: JSON.stringify(['campaign_id', 'stat_time_day']),
    metrics: JSON.stringify([
      'campaign_name',
      'spend',
      'impressions',
      'clicks',
      'conversion',
    ]),
    start_date: args.since,
    end_date: args.until,
    page: '1',
    page_size: '1000',
  })
  return `${API_BASE}/report/integrated/get/?${params}`
}

export async function syncTikTokAds(
  input: TikTokAdsSyncInput,
): Promise<TikTokAdsSyncResult> {
  const provider = 'tiktok_ads' as const
  if (!input.venueId) {
    return syncRefusal(provider, 'not_connected', 'No venue given.')
  }

  const envCheck = readTikTokAdsEnv()
  if (!envCheck.ok) {
    return syncRefusal(
      provider,
      'not_configured',
      `TikTok Ads is not set up yet. Missing: ${envCheck.missing.join(', ')}.`,
    )
  }

  const row = await readConnectionRow(
    provider,
    input.venueId,
    CONNECTION_COLUMNS,
    input.supabase,
  )
  if (statusFromConnection(row) !== 'connected') {
    return syncRefusal(
      provider,
      'not_connected',
      'This venue has not connected a TikTok Ads account yet.',
    )
  }

  const advertiserId = toTextOrNull(row?.advertiser_id)
  if (!advertiserId) {
    return syncRefusal(
      provider,
      'no_account',
      'Connected, but no advertiser account has been chosen to read from.',
    )
  }

  const token = await getValidTikTokToken(input.venueId, {
    supabase: input.supabase,
    fetchImpl: input.fetchImpl,
  })
  if (!token) {
    return syncRefusal(
      provider,
      'not_connected',
      'The saved TikTok permission has lapsed. Reconnect on the settings page.',
    )
  }

  const { since, until } = resolveWindow(
    input.since,
    input.until,
    input.lookbackDays ?? 3,
  )
  const currency = toTextOrNull(row?.currency) ?? 'USD'
  const doFetch = input.fetchImpl ?? fetch

  let parsed: DailyCampaignMetric[]
  try {
    const resp = await doFetch(
      buildReportUrl({ advertiserId, since, until }),
      { headers: { 'Access-Token': token } },
    )
    if (!resp.ok) {
      await markConnectionError(
        provider,
        input.venueId,
        'report_failed',
        `${resp.status} ${(await resp.text()).slice(0, 300)}`,
        input.supabase,
      )
      return syncRefusal(
        provider,
        'api_error',
        `TikTok refused the report request (${resp.status}).`,
      )
    }

    const body = await resp.json()
    const envelope = readTikTokEnvelope(body)
    if (!envelope.ok) {
      await markConnectionError(
        provider,
        input.venueId,
        'report_rejected',
        `code ${envelope.code}: ${envelope.message}`,
        input.supabase,
      )
      return syncRefusal(
        provider,
        'api_error',
        `TikTok would not run the report: ${envelope.message || `code ${envelope.code}`}.`,
      )
    }
    parsed = parseTikTokReportResponse(body, currency)
  } catch (err) {
    await markConnectionError(
      provider,
      input.venueId,
      'report_threw',
      err instanceof Error ? err.message : String(err),
      input.supabase,
    )
    return syncRefusal(
      provider,
      'api_error',
      'Could not reach TikTok for this venue.',
    )
  }

  const written = await writeDailyMetrics({
    venueId: input.venueId,
    provider,
    metrics: parsed,
    supabase: input.supabase,
  })

  await markConnectionSynced(provider, input.venueId, input.supabase)

  return {
    ok: written.rowsFailed === 0,
    provider,
    reason: written.rowsFailed === 0 ? null : 'api_error',
    message:
      written.rowsFailed === 0
        ? null
        : `${written.rowsFailed} row(s) could not be saved: ${written.errors[0]}`,
    rowsInserted: written.rowsInserted,
    rowsUpdated: written.rowsUpdated,
    rowsFailed: written.rowsFailed,
    daysCovered: countDays(parsed),
    since,
    until,
  }
}
