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

async function fetchSeriesObservations(
  seriesId: string,
  apiKey: string,
  startDate: string,
): Promise<FredObservation[]> {
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
    console.error(`[fred-fetch] Network error for ${seriesId}:`, err instanceof Error ? err.message : err)
    return []
  }
  if (!response.ok) {
    console.error(`[fred-fetch] FRED returned ${response.status} for ${seriesId}`)
    return []
  }

  let body: FredApiResponse
  try {
    body = (await response.json()) as FredApiResponse
  } catch {
    console.error(`[fred-fetch] Failed to parse FRED response for ${seriesId}`)
    return []
  }
  if (body.error_message) {
    console.error(`[fred-fetch] FRED error for ${seriesId}:`, body.error_message)
    return []
  }

  return body.observations ?? []
}

export interface FredFetchResult {
  series_id: string
  observations_returned: number
  rows_upserted: number
  error?: string
}

/**
 * Fetch + upsert a single series. Returns counts for the caller to
 * aggregate. Skips '.' observations (FRED's "no value" sentinel).
 */
export async function fetchFredSeries(
  seriesId: string,
  opts: { startDate?: string } = {},
): Promise<FredFetchResult> {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) {
    return { series_id: seriesId, observations_returned: 0, rows_upserted: 0, error: 'FRED_API_KEY not configured' }
  }

  // Default to 13 months ago — gives the correlation engine a full
  // 12-month window plus a one-month margin for lagged math.
  const startDate = opts.startDate ?? new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10)

  const observations = await fetchSeriesObservations(seriesId, apiKey, startDate)
  if (observations.length === 0) {
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
    return {
      series_id: seriesId,
      observations_returned: observations.length,
      rows_upserted: 0,
      error: error.message,
    }
  }
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
