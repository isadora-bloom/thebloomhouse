/**
 * Meta Ads spend connector (W54).
 *
 * Replaces the stub that stood here since Wave 6A. Daily spend,
 * impressions, clicks and lead actions per campaign, pulled from the
 * Meta Marketing API and landed in `marketing_spend_records` next to the
 * rows the manual form writes.
 *
 * Unlike Google Ads, Meta had no connection table and no grant flow, so
 * this file carries both: the authorise round trip, the token store
 * (migration 407, `meta_ads_connections`) and the reporting read.
 *
 * THE READ
 * ========
 *   GET graph.facebook.com/v21.0/act_<ad_account_id>/insights
 *       ?level=campaign
 *       &time_increment=1
 *       &fields=campaign_id,campaign_name,spend,impressions,clicks,actions
 *       &time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
 *
 * `time_increment=1` is what makes a row one campaign on one day.
 * Without it Meta returns the window summed, which would land one blob
 * against the first date and put every downstream day-by-day rollup out.
 *
 * CONVERSIONS ARE AN ARRAY
 * ========================
 * Meta does not return a conversions number. It returns `actions`, a
 * list of every action type the campaign drove, of which most are not
 * what a venue means by a conversion. A video view is not an enquiry. So
 * only the lead-shaped action types count, listed in LEAD_ACTION_TYPES
 * below, and everything else is kept in the stored payload but not
 * counted. Guessing wide here would inflate the conversion figure that
 * cost-per-booking is computed against.
 *
 * TOKENS
 * ======
 * Meta has no refresh grant. A short-lived user token is exchanged once
 * for a long-lived one, good for about sixty days, and that long-lived
 * token is extended by exchanging it for another before it lapses. The
 * connector does that automatically inside the last week of its life.
 *
 * GOING LIVE IS AN OPERATOR STEP
 * ==============================
 * META_ADS_APP_ID, META_ADS_APP_SECRET and META_ADS_OAUTH_REDIRECT_URI,
 * documented on /settings/integrations/meta-ads and in
 * .env.local.example. Until they exist the connector refuses with
 * 'not_configured' and names what is missing.
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

const GRAPH_VERSION = 'v21.0'
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`
const AUTHORIZE_BASE = `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`

/** Read-only, and the account listing needed to pick an ad account. */
const REQUIRED_SCOPES = ['ads_read', 'business_management']

/** Extend the long-lived token when it has less than this left. */
const TOKEN_REFRESH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const CONNECTION_COLUMNS =
  'id, venue_id, ad_account_id, ad_account_name, business_id, ' +
  'token_env_key, access_token, token_expires_at, scope, status, ' +
  'status_reason, connected_at, last_synced_at, last_error_at, ' +
  'last_error_message'

/**
 * Action types that mean a person asked the venue something. Meta has
 * dozens; these are the ones a wedding venue's campaigns actually
 * produce, and counting anything wider would inflate the denominator
 * cost-per-enquiry is read against.
 */
export const LEAD_ACTION_TYPES = new Set([
  'lead',
  'leadgen_grouped',
  'onsite_conversion.lead_grouped',
  'offsite_conversion.fb_pixel_lead',
  'offsite_conversion.fb_pixel_complete_registration',
  'onsite_conversion.messaging_conversation_started_7d',
])

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

export interface MetaAdsEnv {
  appId: string
  appSecret: string
  redirectUri: string
}

export function readMetaAdsEnv():
  | { ok: true; env: MetaAdsEnv }
  | { ok: false; missing: string[] } {
  const appId = process.env.META_ADS_APP_ID
  const appSecret = process.env.META_ADS_APP_SECRET
  const redirectUri = process.env.META_ADS_OAUTH_REDIRECT_URI
  const missing: string[] = []
  if (!appId) missing.push('META_ADS_APP_ID')
  if (!appSecret) missing.push('META_ADS_APP_SECRET')
  if (!redirectUri) missing.push('META_ADS_OAUTH_REDIRECT_URI')
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

export function buildMetaAuthorizeUrl(args: {
  env: MetaAdsEnv
  state: string
}): string {
  const params = new URLSearchParams({
    client_id: args.env.appId,
    redirect_uri: args.env.redirectUri,
    response_type: 'code',
    scope: REQUIRED_SCOPES.join(','),
    state: args.state,
  })
  return `${AUTHORIZE_BASE}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface MetaTokenResponse {
  access_token: string
  token_type?: string
  expires_in?: number
}

/** Code to short-lived token. */
export async function exchangeMetaCode(args: {
  env: MetaAdsEnv
  code: string
  fetchImpl?: typeof fetch
}): Promise<MetaTokenResponse> {
  const doFetch = args.fetchImpl ?? fetch
  const params = new URLSearchParams({
    client_id: args.env.appId,
    client_secret: args.env.appSecret,
    redirect_uri: args.env.redirectUri,
    code: args.code,
  })
  const resp = await doFetch(`${GRAPH_BASE}/oauth/access_token?${params}`)
  if (!resp.ok) {
    throw new Error(`Meta token exchange failed (${resp.status})`)
  }
  return (await resp.json()) as MetaTokenResponse
}

/** Short-lived to long-lived, and long-lived to a fresh long-lived. The
 *  same call does both; Meta calls it fb_exchange_token either way. */
export async function extendMetaToken(args: {
  env: MetaAdsEnv
  token: string
  fetchImpl?: typeof fetch
}): Promise<MetaTokenResponse> {
  const doFetch = args.fetchImpl ?? fetch
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: args.env.appId,
    client_secret: args.env.appSecret,
    fb_exchange_token: args.token,
  })
  const resp = await doFetch(`${GRAPH_BASE}/oauth/access_token?${params}`)
  if (!resp.ok) {
    throw new Error(`Meta token extension failed (${resp.status})`)
  }
  return (await resp.json()) as MetaTokenResponse
}

/** True when a stored token is close enough to lapsing to be worth
 *  extending now rather than discovering it dead mid-sync. */
export function metaTokenNeedsExtending(
  expiresAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!expiresAt) return false
  const at = Date.parse(expiresAt)
  if (!Number.isFinite(at)) return false
  return at - now < TOKEN_REFRESH_WINDOW_MS
}

export interface MetaAdAccount {
  id: string
  name: string | null
  businessId: string | null
}

/** The ad accounts this grant can read. Used by the settings page to
 *  let the coordinator pick which account is theirs. */
export function parseMetaAdAccounts(body: unknown): MetaAdAccount[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []
  const out: MetaAdAccount[] = []
  for (const raw of data) {
    const row = raw as {
      id?: unknown
      account_id?: unknown
      name?: unknown
      business?: { id?: unknown }
    }
    const id =
      toTextOrNull(row.account_id) ??
      toTextOrNull(row.id)?.replace(/^act_/, '') ??
      null
    if (!id) continue
    out.push({
      id,
      name: toTextOrNull(row.name),
      businessId: toTextOrNull(row.business?.id),
    })
  }
  return out
}

export interface PersistMetaConnectionArgs {
  venueId: string
  token: MetaTokenResponse
  adAccountId?: string | null
  adAccountName?: string | null
  businessId?: string | null
  connectedBy?: string | null
  supabase?: SupabaseClient
}

export async function persistMetaConnection(
  args: PersistMetaConnectionArgs,
): Promise<void> {
  const client = args.supabase ?? createServiceClient()
  const expiresAt =
    args.token.expires_in && args.token.expires_in > 0
      ? new Date(Date.now() + args.token.expires_in * 1000).toISOString()
      : null
  const now = new Date().toISOString()
  const { error } = await client
    .from('meta_ads_connections')
    .upsert(
      {
        venue_id: args.venueId,
        access_token: args.token.access_token,
        token_expires_at: expiresAt,
        token_type: args.token.token_type ?? null,
        scope: REQUIRED_SCOPES.join(','),
        ad_account_id: args.adAccountId ?? null,
        ad_account_name: args.adAccountName ?? null,
        business_id: args.businessId ?? null,
        status: 'connected',
        status_reason: null,
        connected_by: args.connectedBy ?? null,
        connected_at: now,
        last_error_at: null,
        last_error_message: null,
      },
      { onConflict: 'venue_id' },
    )
    .select('id')
  if (error) throw new Error(`Saving the Meta connection failed: ${error.message}`)
}

/**
 * A usable token for this venue, extending it first if it is nearly
 * done. Returns null when there is nothing to work with, which the
 * caller reports as not-connected rather than as an error.
 */
export async function getValidMetaToken(
  venueId: string,
  opts: { supabase?: SupabaseClient; fetchImpl?: typeof fetch } = {},
): Promise<string | null> {
  const envCheck = readMetaAdsEnv()
  if (!envCheck.ok) return null

  const row = await readConnectionRow(
    'meta_ads',
    venueId,
    CONNECTION_COLUMNS,
    opts.supabase,
  )
  if (statusFromConnection(row) !== 'connected') return null

  const token = resolveStoredToken(row)
  if (!token) return null

  if (!metaTokenNeedsExtending(row?.token_expires_at as string | null)) {
    return token
  }

  try {
    const extended = await extendMetaToken({
      env: envCheck.env,
      token,
      fetchImpl: opts.fetchImpl,
    })
    await persistMetaConnection({
      venueId,
      token: extended,
      adAccountId: toTextOrNull(row?.ad_account_id),
      adAccountName: toTextOrNull(row?.ad_account_name),
      businessId: toTextOrNull(row?.business_id),
      supabase: opts.supabase,
    })
    return extended.access_token
  } catch (err) {
    await markConnectionError(
      'meta_ads',
      venueId,
      'extend_failed',
      err instanceof Error ? err.message : String(err),
      opts.supabase,
    )
    // The old token may still have days on it. Hand it back rather than
    // failing the whole sync over a refresh that can be retried.
    return token
  }
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function connectorStatus(
  venueId: string,
  supabase?: SupabaseClient,
): Promise<ConnectorStatus> {
  const row = await readConnectionRow(
    'meta_ads',
    venueId,
    CONNECTION_COLUMNS,
    supabase,
  )
  return statusFromConnection(row)
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface MetaInsightRow {
  date_start?: unknown
  campaign_id?: unknown
  campaign_name?: unknown
  spend?: unknown
  impressions?: unknown
  clicks?: unknown
  account_currency?: unknown
  actions?: unknown
}

/** Sum only the lead-shaped action types. */
export function countLeadActions(actions: unknown): number {
  if (!Array.isArray(actions)) return 0
  let total = 0
  for (const raw of actions) {
    const row = raw as { action_type?: unknown; value?: unknown }
    const type = toTextOrNull(row.action_type)
    if (!type || !LEAD_ACTION_TYPES.has(type)) continue
    total += toDecimal(row.value)
  }
  return total
}

/**
 * Parse an insights response into one metric per campaign per day.
 *
 * `date_start` equals `date_stop` when time_increment=1, so date_start
 * is the day. A row without one is dropped rather than dated by guess.
 */
export function parseMetaInsightsResponse(
  body: unknown,
): DailyCampaignMetric[] {
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return []

  const out: DailyCampaignMetric[] = []
  for (const raw of data) {
    const row = raw as MetaInsightRow
    const spendDate = toTextOrNull(row.date_start)
    if (!spendDate || !/^\d{4}-\d{2}-\d{2}$/.test(spendDate)) continue

    out.push({
      spendDate,
      campaignId: toTextOrNull(row.campaign_id),
      campaignName: toTextOrNull(row.campaign_name),
      amountCents: decimalToCents(row.spend),
      impressions: toCount(row.impressions),
      clicks: toCount(row.clicks),
      conversions: countLeadActions(row.actions),
      currency: toTextOrNull(row.account_currency) ?? 'USD',
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface MetaAdsSyncInput {
  venueId: string
  since?: string
  until?: string
  lookbackDays?: number
  supabase?: SupabaseClient
  fetchImpl?: typeof fetch
}

export type MetaAdsSyncResult = AdSyncResult

export function buildInsightsUrl(args: {
  adAccountId: string
  since: string
  until: string
}): string {
  const params = new URLSearchParams({
    level: 'campaign',
    time_increment: '1',
    fields:
      'campaign_id,campaign_name,spend,impressions,clicks,actions,account_currency',
    time_range: JSON.stringify({ since: args.since, until: args.until }),
    limit: '500',
  })
  return `${GRAPH_BASE}/act_${args.adAccountId}/insights?${params}`
}

export async function syncMetaAds(
  input: MetaAdsSyncInput,
): Promise<MetaAdsSyncResult> {
  const provider = 'meta_ads' as const
  if (!input.venueId) {
    return syncRefusal(provider, 'not_connected', 'No venue given.')
  }

  const envCheck = readMetaAdsEnv()
  if (!envCheck.ok) {
    return syncRefusal(
      provider,
      'not_configured',
      `Meta Ads is not set up yet. Missing: ${envCheck.missing.join(', ')}.`,
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
      'This venue has not connected a Meta Ads account yet.',
    )
  }

  const adAccountId = toTextOrNull(row?.ad_account_id)?.replace(/^act_/, '')
  if (!adAccountId) {
    return syncRefusal(
      provider,
      'no_account',
      'Connected, but no ad account has been chosen to read from.',
    )
  }

  const token = await getValidMetaToken(input.venueId, {
    supabase: input.supabase,
    fetchImpl: input.fetchImpl,
  })
  if (!token) {
    return syncRefusal(
      provider,
      'not_connected',
      'The saved Meta permission has lapsed. Reconnect on the settings page.',
    )
  }

  const { since, until } = resolveWindow(
    input.since,
    input.until,
    input.lookbackDays ?? 3,
  )
  const doFetch = input.fetchImpl ?? fetch

  let parsed: DailyCampaignMetric[]
  try {
    const resp = await doFetch(
      buildInsightsUrl({ adAccountId, since, until }),
      { headers: { Authorization: `Bearer ${token}` } },
    )
    if (!resp.ok) {
      const text = (await resp.text()).slice(0, 300)
      await markConnectionError(
        provider,
        input.venueId,
        'report_failed',
        `${resp.status} ${text}`,
        input.supabase,
      )
      return syncRefusal(
        provider,
        'api_error',
        `Meta refused the report request (${resp.status}).`,
      )
    }
    parsed = parseMetaInsightsResponse(await resp.json())
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
      'Could not reach Meta for this venue.',
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
