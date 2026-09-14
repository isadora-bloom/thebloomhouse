/**
 * Google Ads spend connector (W54).
 *
 * Replaces the stub that stood here since Wave 6A. Daily spend,
 * impressions, clicks and conversions per campaign, pulled from the
 * Google Ads API and landed in `marketing_spend_records` next to the
 * rows the manual form writes.
 *
 * WHERE THE PIECES ARE
 * ====================
 * The OAuth round trip, the token store and the refresh already exist:
 * `src/lib/services/integrations/google-ads-oauth.ts`, backed by
 * `google_ads_connections` (migration 310). This file does not repeat
 * any of that. It asks that module for a live access token and spends
 * its own attention on the reporting query.
 *
 * THE QUERY
 * =========
 * One GAQL statement against the `campaign` resource, segmented by
 * date, over the search-stream endpoint:
 *
 *   SELECT campaign.id, campaign.name, segments.date,
 *          metrics.cost_micros, metrics.impressions, metrics.clicks,
 *          metrics.conversions, customer.currency_code
 *   FROM campaign
 *   WHERE segments.date BETWEEN '<since>' AND '<until>'
 *
 * `segments.date` is what makes a row one campaign on one day, which is
 * exactly the grain `marketing_spend_records` stores. Cost comes back in
 * micros, so a pound is 1,000,000 and a cent is 10,000.
 *
 * CONNECTED OR NOT, PER VENUE
 * ===========================
 * `connectorStatus(venueId)` answers 'connected' only when that venue's
 * row carries a token. Every other case is 'manual'. The reallocation
 * page reads it to decide whether to tell the coordinator their Google
 * Ads figures were typed in, so the copy flips per venue on its own
 * rather than waiting on someone to edit a sentence.
 *
 * GOING LIVE IS AN OPERATOR STEP
 * ==============================
 * Four environment variables and a developer token, documented on
 * /settings/integrations/google-ads and in .env.local.example. Until
 * they exist the connector refuses with 'not_configured' and says which
 * ones are missing. Same shape as Instagram DMs waiting on Meta
 * credentials.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  readGoogleAdsOauthEnv,
  getValidAccessToken,
} from '@/lib/services/integrations/google-ads-oauth'
import {
  countDays,
  markConnectionError,
  markConnectionSynced,
  microsToCents,
  readConnectionRow,
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

const API_VERSION = 'v18'
const SEARCH_STREAM_BASE = 'https://googleads.googleapis.com'

/** Columns the status read and the sync read need. Never selects a
 *  token except through the OAuth module, which is service-role only. */
const CONNECTION_COLUMNS =
  'id, venue_id, customer_id, customer_name, status, status_reason, ' +
  'access_token, refresh_token, connected_at, last_synced_at, ' +
  'last_error_at, last_error_message'

export interface GoogleAdsSyncInput {
  venueId: string
  /** YYYY-MM-DD. Defaults to a three-day window ending today. */
  since?: string
  until?: string
  /** Overrides the default window length when since/until are absent. */
  lookbackDays?: number
  supabase?: SupabaseClient
  /** Injected in tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export type GoogleAdsSyncResult = AdSyncResult

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * 'connected' when this venue has a live Google Ads token, 'manual'
 * otherwise. Venue-scoped: the read filters on venue_id, so one venue's
 * token can never answer for another.
 */
export async function connectorStatus(
  venueId: string,
  supabase?: SupabaseClient,
): Promise<ConnectorStatus> {
  const row = await readConnectionRow(
    'google_ads',
    venueId,
    CONNECTION_COLUMNS,
    supabase,
  )
  return statusFromConnection(row)
}

// ---------------------------------------------------------------------------
// GAQL
// ---------------------------------------------------------------------------

export function buildCampaignQuery(since: string, until: string): string {
  return [
    'SELECT campaign.id, campaign.name, segments.date,',
    'metrics.cost_micros, metrics.impressions, metrics.clicks,',
    'metrics.conversions, customer.currency_code',
    'FROM campaign',
    `WHERE segments.date BETWEEN '${since}' AND '${until}'`,
  ].join(' ')
}

/** Google returns the customer id with dashes in the UI and without in
 *  the API path. Accept either from the operator. */
export function normaliseCustomerId(raw: unknown): string | null {
  const text = toTextOrNull(raw)
  if (!text) return null
  const digits = text.replace(/[^0-9]/g, '')
  return digits === '' ? null : digits
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface GoogleAdsRow {
  campaign?: { id?: unknown; name?: unknown }
  segments?: { date?: unknown }
  metrics?: {
    costMicros?: unknown
    impressions?: unknown
    clicks?: unknown
    conversions?: unknown
  }
  customer?: { currencyCode?: unknown }
}

/**
 * Parse a search-stream response into one metric per campaign per day.
 *
 * The endpoint answers with an ARRAY of chunks, each `{ results: [...] }`.
 * A single-chunk `{ results: [...] }` object is accepted too, because
 * the non-streaming `search` endpoint answers that way and a caller who
 * swaps endpoints should not silently get zero rows.
 *
 * Anything without a date is dropped rather than guessed at. A spend row
 * with the wrong day is worse than a missing one: it moves money between
 * days in every downstream rollup.
 */
export function parseGoogleAdsResponse(body: unknown): DailyCampaignMetric[] {
  const chunks: unknown[] = Array.isArray(body) ? body : [body]
  const out: DailyCampaignMetric[] = []

  for (const chunk of chunks) {
    const results = (chunk as { results?: unknown } | null)?.results
    if (!Array.isArray(results)) continue

    for (const raw of results) {
      const row = raw as GoogleAdsRow
      const spendDate = toTextOrNull(row.segments?.date)
      if (!spendDate || !/^\d{4}-\d{2}-\d{2}$/.test(spendDate)) continue

      out.push({
        spendDate,
        campaignId: toTextOrNull(row.campaign?.id),
        campaignName: toTextOrNull(row.campaign?.name),
        amountCents: microsToCents(row.metrics?.costMicros),
        impressions: toCount(row.metrics?.impressions),
        clicks: toCount(row.metrics?.clicks),
        conversions: toDecimal(row.metrics?.conversions),
        currency: toTextOrNull(row.customer?.currencyCode) ?? 'USD',
      })
    }
  }

  return out
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncGoogleAds(
  input: GoogleAdsSyncInput,
): Promise<GoogleAdsSyncResult> {
  const provider = 'google_ads' as const
  if (!input.venueId) {
    return syncRefusal(provider, 'not_connected', 'No venue given.')
  }

  const envCheck = readGoogleAdsOauthEnv()
  if (!envCheck.ok) {
    return syncRefusal(
      provider,
      'not_configured',
      `Google Ads is not set up yet. Missing: ${envCheck.missing.join(', ')}.`,
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
      'This venue has not connected a Google Ads account yet.',
    )
  }

  const customerId = normaliseCustomerId(row?.customer_id)
  if (!customerId) {
    return syncRefusal(
      provider,
      'no_account',
      'Connected, but no Google Ads account has been chosen to read from.',
    )
  }

  const accessToken = await getValidAccessToken(input.venueId)
  if (!accessToken) {
    return syncRefusal(
      provider,
      'not_connected',
      'The saved Google Ads permission has lapsed. Reconnect on the settings page.',
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
      `${SEARCH_STREAM_BASE}/${API_VERSION}/customers/${customerId}/googleAds:searchStream`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'developer-token': envCheck.env.developerToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query: buildCampaignQuery(since, until) }),
      },
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
        `Google Ads refused the report request (${resp.status}).`,
      )
    }
    parsed = parseGoogleAdsResponse(await resp.json())
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await markConnectionError(
      provider,
      input.venueId,
      'report_threw',
      message,
      input.supabase,
    )
    return syncRefusal(
      provider,
      'api_error',
      'Could not reach Google Ads for this venue.',
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
