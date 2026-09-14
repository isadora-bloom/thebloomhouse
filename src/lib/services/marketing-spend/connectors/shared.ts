/**
 * Ad-connector shared parts (W54).
 *
 * Google Ads, Meta Ads and TikTok Ads all answer the same question in
 * three different dialects: what did this venue spend, on which
 * campaign, on which day, and what did it get back. This module holds
 * the parts that are the same in all three so the per-provider files
 * carry only the dialect.
 *
 * WHAT THE SPINE EXPECTS
 * ======================
 * Every row lands in `marketing_spend_records` through `recordSpend`,
 * the one writer. The `channel` value matters more than it looks:
 * `loadSpendByChannel` in `services/attribution/couple-attribution.ts`
 * joins spend to touchpoints on the channel string verbatim, and
 * `rollupChannels` turns that join into CAC and revenue per pound. So
 * the connector channel keys are the canonical ones from `ingest.ts`
 * (`google_ads`, `meta_ads`, `tiktok_ads`) and nothing else. A connector
 * that invents its own key produces spend nobody can attribute.
 *
 * IDEMPOTENCE
 * ===========
 * `marketing_spend_records` carries a unique index on
 * (venue_id, channel, COALESCE(campaign_id, ''), spend_date). Re-running
 * a day therefore cannot double the spend: the second insert raises
 * 23505 and `recordSpend` reports it as a duplicate.
 *
 * That alone would leave the numbers stale, though, and ad platforms
 * restate a day for a while after it closes (late conversions, invalid
 * click credits). So on a duplicate we UPDATE the existing row in place
 * rather than skipping it. One row per campaign per day, always carrying
 * the platform's latest word on it.
 *
 * Note the unique index is on an EXPRESSION, so `.upsert({onConflict})`
 * cannot target it (PostgREST answers 42P10). Insert-then-update is the
 * shape that works. See feedback-supabase-service-role-scope.
 *
 * TOKENS NEVER LEAVE THE SERVICE ROLE
 * ===================================
 * Every read of a connection row here goes through the service client
 * and filters on venue_id. Venue isolation on a credential is not a
 * nicety: one venue's token pointed at another venue's rows would pull
 * a stranger's ad account into their numbers.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { recordSpend } from '../ingest'

/**
 * The anti-forgery state token on the authorise round trip is
 * provider-neutral: an HMAC of venue id, user id, a nonce and a timestamp,
 * signed with STATE_SIGNING_SECRET and good for ten minutes. It was
 * written for Google Ads first and still lives in that module, which now
 * wraps the shared signer at integrations/oauth-state.ts. Re-exported here
 * under a neutral name rather than copied, because two implementations of
 * one CSRF check is one more than anyone can keep correct.
 */
export {
  mintOauthState as mintAdOauthState,
  verifyOauthState as verifyAdOauthState,
} from '@/lib/services/integrations/google-ads-oauth'

// ---------------------------------------------------------------------------
// Provider vocabulary
// ---------------------------------------------------------------------------

/** What the coordinator-facing copy says about a provider for this venue. */
export type ConnectorStatus = 'connected' | 'manual'

export type AdProvider = 'google_ads' | 'meta_ads' | 'tiktok_ads'

export const AD_PROVIDERS: readonly AdProvider[] = [
  'google_ads',
  'meta_ads',
  'tiktok_ads',
] as const

/**
 * Channel key per provider. Canonical values from `ingest.ts`; the same
 * strings attribution joins spend to touchpoints on.
 */
export const PROVIDER_CHANNEL: Record<AdProvider, string> = {
  google_ads: 'google_ads',
  meta_ads: 'meta_ads',
  tiktok_ads: 'tiktok_ads',
}

/** `ingested_by` label. Drives the connector-health read on the spend page. */
export const PROVIDER_INGESTED_BY: Record<AdProvider, string> = {
  google_ads: 'google_ads_connector',
  meta_ads: 'meta_ads_connector',
  tiktok_ads: 'tiktok_ads_connector',
}

/** Connection table per provider. Google Ads uses migration 310's table;
 *  Meta and TikTok use migration 407's. */
export const PROVIDER_TABLE: Record<AdProvider, string> = {
  google_ads: 'google_ads_connections',
  meta_ads: 'meta_ads_connections',
  tiktok_ads: 'tiktok_ads_connections',
}

// ---------------------------------------------------------------------------
// The shape every provider parser returns
// ---------------------------------------------------------------------------

/** One campaign, one day. The unit all three APIs agree on. */
export interface DailyCampaignMetric {
  /** YYYY-MM-DD in the ad account's reporting timezone. */
  spendDate: string
  campaignId: string | null
  campaignName: string | null
  amountCents: number
  impressions: number
  clicks: number
  /** Fractional on Meta and Google, which attribute part of a conversion
   *  to a click. Kept as given rather than rounded away. */
  conversions: number
  currency: string
}

export type AdSyncReason =
  | 'not_configured'
  | 'not_connected'
  | 'no_account'
  | 'api_error'

export interface AdSyncResult {
  ok: boolean
  provider: AdProvider
  /** Null on success. */
  reason: AdSyncReason | null
  /** Plain-English line for the operator. Never carries a token. */
  message: string | null
  rowsInserted: number
  rowsUpdated: number
  rowsFailed: number
  daysCovered: number
  since: string | null
  until: string | null
}

export function syncRefusal(
  provider: AdProvider,
  reason: AdSyncReason,
  message: string,
): AdSyncResult {
  return {
    ok: false,
    provider,
    reason,
    message,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsFailed: 0,
    daysCovered: 0,
    since: null,
    until: null,
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function isIsoDate(v: unknown): v is string {
  return typeof v === 'string' && ISO_DATE_RE.test(v)
}

export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/** Default reporting window: today and the previous `lookbackDays - 1`
 *  days. Today is included on purpose. Its numbers are partial, and the
 *  update-on-duplicate path above is what corrects them tomorrow. */
export function defaultWindow(
  lookbackDays = 3,
  now: Date = new Date(),
): { since: string; until: string } {
  const days = Math.max(1, Math.min(400, Math.trunc(lookbackDays)))
  const until = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  )
  const since = new Date(until.getTime() - (days - 1) * 86_400_000)
  return { since: toIsoDate(since), until: toIsoDate(until) }
}

/** Normalise a caller-supplied window, falling back to the default. */
export function resolveWindow(
  since: string | undefined,
  until: string | undefined,
  lookbackDays = 3,
  now: Date = new Date(),
): { since: string; until: string } {
  const fallback = defaultWindow(lookbackDays, now)
  const s = isIsoDate(since) ? since : fallback.since
  const u = isIsoDate(until) ? until : fallback.until
  return s <= u ? { since: s, until: u } : { since: u, until: s }
}

// ---------------------------------------------------------------------------
// Number coercion
// ---------------------------------------------------------------------------

/**
 * Money as a decimal string ("12.34") to whole cents. Meta and TikTok
 * both report this way. Parsing is deliberately strict about the result
 * being finite: a NaN silently coerced to 0 is a spend figure that
 * quietly under-reports, which is worse than refusing the row.
 */
export function decimalToCents(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 100)
}

/** Google reports cost in micros (millionths of the account currency). */
export function microsToCents(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n / 10_000)
}

export function toCount(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n)
}

export function toDecimal(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isFinite(n) || n < 0) return 0
  return n
}

export function toTextOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const t = value.trim()
    return t === '' ? null : t
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

// ---------------------------------------------------------------------------
// Writing the rows
// ---------------------------------------------------------------------------

export interface WriteMetricsArgs {
  venueId: string
  provider: AdProvider
  metrics: DailyCampaignMetric[]
  supabase?: SupabaseClient
  /** Stamped into source_platform_metadata so the spend page can show
   *  when the platform was last asked. */
  syncedAt?: string
}

export interface WriteMetricsOutcome {
  rowsInserted: number
  rowsUpdated: number
  rowsFailed: number
  errors: string[]
}

/**
 * Land a parsed reporting window in `marketing_spend_records`.
 *
 * Insert first. On the unique-index collision, update the row that is
 * already there. Never two rows for one campaign-day, never a sum of two
 * runs of the same day.
 */
export async function writeDailyMetrics(
  args: WriteMetricsArgs,
): Promise<WriteMetricsOutcome> {
  const supabase = args.supabase ?? createServiceClient()
  const channel = PROVIDER_CHANNEL[args.provider]
  const ingestedBy = PROVIDER_INGESTED_BY[args.provider]
  const syncedAt = args.syncedAt ?? new Date().toISOString()

  const out: WriteMetricsOutcome = {
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsFailed: 0,
    errors: [],
  }

  for (const m of args.metrics) {
    const sourcePayload: Record<string, unknown> = {
      provider: args.provider,
      impressions: m.impressions,
      clicks: m.clicks,
      conversions: m.conversions,
      campaign_id: m.campaignId,
      campaign_name: m.campaignName,
      synced_at: syncedAt,
    }

    const result = await recordSpend({
      venueId: args.venueId,
      channel,
      campaignId: m.campaignId,
      campaignName: m.campaignName,
      spendDate: m.spendDate,
      amountCents: m.amountCents,
      currency: m.currency,
      sourcePayload,
      ingestedBy,
      supabase,
    })

    if (!result.ok) {
      out.rowsFailed += 1
      out.errors.push(`${m.spendDate}/${m.campaignId ?? '-'}: ${result.error}`)
      continue
    }

    if (result.inserted) {
      out.rowsInserted += 1
      continue
    }

    // Already there from an earlier run of the same day. Refresh it so a
    // restated figure replaces the first guess instead of being dropped.
    let query = supabase
      .from('marketing_spend_records')
      .update({
        amount_cents: m.amountCents,
        campaign_name: m.campaignName,
        currency: (m.currency || 'USD').toUpperCase(),
        source_platform_metadata: sourcePayload,
        ingested_by: ingestedBy,
      })
      .eq('venue_id', args.venueId)
      .eq('channel', channel)
      .eq('spend_date', m.spendDate)

    query =
      m.campaignId === null
        ? query.is('campaign_id', null)
        : query.eq('campaign_id', m.campaignId)

    // `.select()` on purpose: a PostgREST UPDATE that matches no rows
    // answers 204 and looks like a success. See
    // feedback_postgrest_silent_update.
    const { data, error } = await query.select('id')

    if (error) {
      out.rowsFailed += 1
      out.errors.push(`${m.spendDate}/${m.campaignId ?? '-'}: ${error.message}`)
      continue
    }
    if (!data || data.length === 0) {
      out.rowsFailed += 1
      out.errors.push(
        `${m.spendDate}/${m.campaignId ?? '-'}: refresh matched no row`,
      )
      continue
    }
    out.rowsUpdated += 1
  }

  return out
}

/** How many distinct days a parsed window covered. */
export function countDays(metrics: DailyCampaignMetric[]): number {
  return new Set(metrics.map((m) => m.spendDate)).size
}

// ---------------------------------------------------------------------------
// Connection-row helpers
// ---------------------------------------------------------------------------

/** The four fields every provider's connection row shares. */
export interface ConnectionTokenFields {
  status?: string | null
  access_token?: string | null
  refresh_token?: string | null
  token_env_key?: string | null
}

/**
 * Resolve a token that is held either directly on the row or by name in
 * an environment variable. The env-var form is the safe default while
 * encryption at rest is still owed on these columns, and it is the same
 * choice migration 401 made for the Instagram page token.
 */
export function resolveStoredToken(
  row: ConnectionTokenFields | null | undefined,
): string | null {
  if (!row) return null
  const envKey = row.token_env_key
  if (typeof envKey === 'string' && envKey.trim() !== '') {
    const fromEnv = process.env[envKey.trim()]
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  }
  const direct = row.access_token
  if (typeof direct === 'string' && direct.trim() !== '') return direct.trim()
  return null
}

/**
 * The status rule, one place. 'connected' when the row says connected
 * AND something that can be exchanged for a live call is on it. Anything
 * else is 'manual', which is what the coordinator-facing copy then says.
 */
export function statusFromConnection(
  row: ConnectionTokenFields | null | undefined,
): ConnectorStatus {
  if (!row) return 'manual'
  if (row.status !== 'connected') return 'manual'
  if (resolveStoredToken(row)) return 'connected'
  const refresh = row.refresh_token
  if (typeof refresh === 'string' && refresh.trim() !== '') return 'connected'
  return 'manual'
}

/**
 * Read one venue's connection row. Filters on venue_id, always. This is
 * the function the venue-isolation test in this workstream points at.
 */
export async function readConnectionRow(
  provider: AdProvider,
  venueId: string,
  columns: string,
  supabase?: SupabaseClient,
): Promise<Record<string, unknown> | null> {
  if (!venueId) return null
  const client = supabase ?? createServiceClient()
  const { data, error } = await client
    .from(PROVIDER_TABLE[provider])
    .select(columns)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) return null
  return (data as Record<string, unknown> | null) ?? null
}

/** Stamp an error on a connection row without ever echoing a token. */
export async function markConnectionError(
  provider: AdProvider,
  venueId: string,
  reason: string,
  message: string,
  supabase?: SupabaseClient,
): Promise<void> {
  const client = supabase ?? createServiceClient()
  await client
    .from(PROVIDER_TABLE[provider])
    .update({
      status: 'error',
      status_reason: reason.slice(0, 100),
      last_error_at: new Date().toISOString(),
      last_error_message: message.slice(0, 500),
    })
    .eq('venue_id', venueId)
}

/** Stamp a successful sync. */
export async function markConnectionSynced(
  provider: AdProvider,
  venueId: string,
  supabase?: SupabaseClient,
): Promise<void> {
  const client = supabase ?? createServiceClient()
  await client
    .from(PROVIDER_TABLE[provider])
    .update({
      last_synced_at: new Date().toISOString(),
      status: 'connected',
      status_reason: null,
    })
    .eq('venue_id', venueId)
}
