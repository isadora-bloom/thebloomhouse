/**
 * FRED writer — daily cron + onboarding 12-month backfill
 * (ARCH-18.3-D / Playbook 17.4-A).
 *
 * The reader (./fred.ts loadFredSeries) was shipped in T2-C but the
 * cron-driven WRITER was deferred. Without the writer, fred_indicators
 * sits empty and the correlation engine's macro channels are
 * permanently null even though the schema + reader are correct.
 *
 * This module fetches each DEFAULT_FRED_SERIES from FRED's public API
 * and upserts into fred_indicators. Public endpoint:
 *   https://api.stlouisfed.org/fred/series/observations
 *     ?series_id=<id>&observation_start=YYYY-MM-DD&api_key=<key>&file_type=json
 *
 * Idempotent — upsert on (series_id, region, observation_date).
 * FRED revises historical values occasionally; the latest revision wins.
 *
 * Env: FRED_API_KEY (free, register at https://fred.stlouisfed.org/docs/api/api_key.html).
 */

import { createServiceClient } from '@/lib/supabase/service'
import { DEFAULT_FRED_SERIES } from './fred'

const FRED_ENDPOINT = 'https://api.stlouisfed.org/fred/series/observations'
const THROTTLE_MS = 800  // FRED rate limit ~120/min; 800ms inter-request keeps us safe

interface FredObservation {
  date: string         // YYYY-MM-DD
  value: string        // FRED returns numbers as strings; '.' = no observation
}

interface FredApiResponse {
  observations?: FredObservation[]
  error_message?: string
  error_code?: number
}

interface FredSeriesMetadata {
  units?: string
  frequency?: string
}

const SERIES_METADATA: Record<string, FredSeriesMetadata> = {
  CPIAUCSL:     { units: 'Index 1982-1984=100', frequency: 'monthly' },
  MORTGAGE30US: { units: '%',                    frequency: 'weekly'  },
  SP500:        { units: 'Index',                frequency: 'daily'   },
  UNRATE:       { units: '%',                    frequency: 'monthly' },
  UMCSENT:      { units: 'Index 1Q66=100',       frequency: 'monthly' },
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface FetchObservationsOutcome {
  observations: FredObservation[]
  fetchError: string | null
}

async function fetchSeriesObservations(
  seriesId: string,
  apiKey: string,
  startDate: string,
): Promise<FetchObservationsOutcome> {
  const params = new URLSearchParams({
    series_id: seriesId,
    observation_start: startDate,
    api_key: apiKey,
    file_type: 'json',
  })
  const url = `${FRED_ENDPOINT}?${params.toString()}`

  let response: Response
  try {
    response = await fetch(url)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[fred-fetch] Network error for ${seriesId}:`, msg)
    return { observations: [], fetchError: `network: ${msg}` }
  }
  if (!response.ok) {
    console.error(`[fred-fetch] FRED returned ${response.status} for ${seriesId}`)
    return { observations: [], fetchError: `http ${response.status}` }
  }

  let body: FredApiResponse
  try {
    body = (await response.json()) as FredApiResponse
  } catch {
    console.error(`[fred-fetch] Failed to parse FRED response for ${seriesId}`)
    return { observations: [], fetchError: 'parse error' }
  }
  if (body.error_message) {
    console.error(`[fred-fetch] FRED error for ${seriesId}:`, body.error_message)
    return { observations: [], fetchError: body.error_message }
  }

  return { observations: body.observations ?? [], fetchError: null }
}

export interface FredFetchResult {
  series_id: string
  observations_returned: number
  rows_upserted: number
  error?: string
}

const FRED_BACKFILL_DAYS = 400  // 13 months gives the correlation engine a full 12-month window plus margin
const FRED_OVERLAP_DAYS = 1     // FRED revises historical values; re-pull the last day every tick

/**
 * Read the per-series watermark from fred_series_sync_state. Returns the
 * last successful fetch timestamp or null if this series has never synced
 * (or sync state row is absent). See migration 311.
 */
async function getFredWatermark(seriesId: string): Promise<Date | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('fred_series_sync_state')
    .select('last_fetched_at')
    .eq('series_id', seriesId)
    .maybeSingle()
  if (error || !data?.last_fetched_at) return null
  const t = new Date(data.last_fetched_at as string)
  return Number.isFinite(t.getTime()) ? t : null
}

async function recordFredSuccess(seriesId: string): Promise<void> {
  const supabase = createServiceClient()
  const nowIso = new Date().toISOString()
  await supabase
    .from('fred_series_sync_state')
    .upsert(
      {
        series_id: seriesId,
        last_fetched_at: nowIso,
        last_error_at: null,
        last_error: null,
        updated_at: nowIso,
      },
      { onConflict: 'series_id' },
    )
}

async function recordFredError(seriesId: string, message: string): Promise<void> {
  const supabase = createServiceClient()
  const nowIso = new Date().toISOString()
  // Don't touch last_fetched_at: we want the next run to retry from the
  // same watermark, not silently advance past a failed window.
  const existing = await supabase
    .from('fred_series_sync_state')
    .select('last_fetched_at')
    .eq('series_id', seriesId)
    .maybeSingle()
  await supabase
    .from('fred_series_sync_state')
    .upsert(
      {
        series_id: seriesId,
        last_fetched_at: existing.data?.last_fetched_at ?? null,
        last_error_at: nowIso,
        last_error: message.slice(0, 500),
        updated_at: nowIso,
      },
      { onConflict: 'series_id' },
    )
}

/**
 * Fetch + upsert a single series. Returns counts for the caller to
 * aggregate. Skips '.' observations (FRED's "no value" sentinel).
 *
 * Watermark behaviour (Pattern 4, mig 311):
 *   - First sync (no fred_series_sync_state row): backfill 400 days.
 *   - Subsequent: pull from (last_fetched_at - 1 day) to today.
 *   - opts.startDate forces a full refetch from the caller-supplied date.
 *   - Success upserts the watermark; failure records last_error without
 *     advancing last_fetched_at so the next run retries the same window.
 */
export async function fetchFredSeries(
  seriesId: string,
  opts: { startDate?: string } = {},
): Promise<FredFetchResult> {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) {
    return { series_id: seriesId, observations_returned: 0, rows_upserted: 0, error: 'FRED_API_KEY not configured' }
  }

  let startDate: string
  if (opts.startDate) {
    startDate = opts.startDate
  } else {
    const watermark = await getFredWatermark(seriesId)
    if (watermark) {
      const overlapped = new Date(watermark.getTime() - FRED_OVERLAP_DAYS * 86_400_000)
      startDate = overlapped.toISOString().slice(0, 10)
    } else {
      startDate = new Date(Date.now() - FRED_BACKFILL_DAYS * 86_400_000).toISOString().slice(0, 10)
    }
  }

  const { observations, fetchError } = await fetchSeriesObservations(seriesId, apiKey, startDate)
  if (fetchError) {
    await recordFredError(seriesId, fetchError)
    return {
      series_id: seriesId,
      observations_returned: 0,
      rows_upserted: 0,
      error: fetchError,
    }
  }
  if (observations.length === 0) {
    // Empty result is not necessarily a failure (FRED can return 0 obs
    // when there are no new data points since the last revision). Treat
    // as success so the watermark advances and we don't keep re-pulling
    // the same empty window.
    await recordFredSuccess(seriesId)
    return { series_id: seriesId, observations_returned: 0, rows_upserted: 0 }
  }

  const meta = SERIES_METADATA[seriesId] ?? {}
  const rows = observations
    .filter((obs) => obs.value !== '.' && obs.value !== '' && obs.value !== undefined)
    .map((obs) => ({
      series_id: seriesId,
      // T5-Rixey-XX: pass empty string '' (not NULL) so the plain
      // unique index uq_fred_indicators_series_region_date_plain
      // (mig 188) actually constrains. Postgres treats NULL as
      // not-equal-NULL in plain unique indexes, which silently
      // bypassed conflict detection. The legacy COALESCE-based
      // index uq_fred_indicators_series_region_date (mig 138)
      // already evaluated NULL as '' so this is a no-op for that
      // index — total semantics unchanged, just made resolvable
      // by ON CONFLICT.
      region: '',
      observation_date: obs.date,
      value: Number(obs.value),
      units: meta.units ?? null,
      frequency: meta.frequency ?? null,
      fetched_at: new Date().toISOString(),
    }))
    .filter((r) => Number.isFinite(r.value))

  if (rows.length === 0) {
    // All observations filtered (e.g. all '.' sentinels). Treat as a
    // successful tick so we don't re-scan the same null window.
    await recordFredSuccess(seriesId)
    return { series_id: seriesId, observations_returned: observations.length, rows_upserted: 0 }
  }

  const supabase = createServiceClient()
  const { error, data: insertedRows } = await supabase
    .from('fred_indicators')
    // T5-Rixey-XX: matched by uq_fred_indicators_series_region_date_plain (mig 188).
    .upsert(rows, { onConflict: 'series_id,region,observation_date', ignoreDuplicates: false })
    .select('id')
  const count = insertedRows?.length ?? 0
  if (error) {
    await recordFredError(seriesId, error.message)
    return {
      series_id: seriesId,
      observations_returned: observations.length,
      rows_upserted: 0,
      error: error.message,
    }
  }
  await recordFredSuccess(seriesId)
  return {
    series_id: seriesId,
    observations_returned: observations.length,
    rows_upserted: count,
  }
}

/**
 * Cron-driven daily refresh of all DEFAULT_FRED_SERIES. Throttled
 * inter-series so FRED's ~120/min rate limit isn't tripped under
 * concurrent venue load.
 *
 * Used by: /api/cron (when wired) + /api/onboarding/backfill?category=fred.
 */
export async function fetchAllDefaultFredSeries(opts: { startDate?: string } = {}): Promise<FredFetchResult[]> {
  const out: FredFetchResult[] = []
  for (let i = 0; i < DEFAULT_FRED_SERIES.length; i++) {
    if (i > 0) await sleep(THROTTLE_MS)
    out.push(await fetchFredSeries(DEFAULT_FRED_SERIES[i].id, opts))
  }
  return out
}
