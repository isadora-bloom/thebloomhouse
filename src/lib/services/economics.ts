/**
 * Bloom House: Economic Indicators Service
 *
 * Fetches macroeconomic signals from FRED (Federal Reserve Economic Data)
 * that affect wedding spending patterns. Composites them into a demand score
 * used by the intelligence layer.
 *
 * Series tracked:
 *   - Consumer sentiment (UMCSENT)
 *   - Personal savings rate (PSAVERT)
 *   - Real disposable income (DSPIC96)
 *   - Housing starts (HOUST)
 *   - Consumer confidence (CONCCONF)
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// FRED series → indicator name mapping
// ---------------------------------------------------------------------------

const FRED_SERIES: Record<string, string> = {
  UMCSENT: 'consumer_sentiment',
  PSAVERT: 'personal_savings_rate',
  DSPIC96: 'disposable_income_real',
  HOUST: 'housing_starts',
  CONCCONF: 'consumer_confidence',
}

const FRED_BASE_URL = 'https://api.stlouisfed.org/fred/series/observations'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FredObservation {
  date: string
  value: string
}

interface FredResponse {
  observations: FredObservation[]
}

export interface DemandScore {
  score: number
  outlook: 'positive' | 'neutral' | 'caution'
}

export interface IndicatorRow {
  indicator_name: string
  date: string
  value: number
  source: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Fetch a single FRED series
// ---------------------------------------------------------------------------

/**
 * Fetch observations for one FRED series and upsert into economic_indicators.
 * Skips missing values (FRED uses "." for missing data).
 */
export async function fetchFredSeries(
  seriesId: string,
  indicatorName: string,
  yearsBack = 3
): Promise<number> {
  const apiKey = process.env.FRED_API_KEY
  if (!apiKey) {
    console.warn('[economics] FRED_API_KEY not set — skipping fetch for', seriesId)
    return 0
  }

  const end = new Date()
  const start = new Date()
  start.setFullYear(start.getFullYear() - yearsBack)

  const url = new URL(FRED_BASE_URL)
  url.searchParams.set('series_id', seriesId)
  url.searchParams.set('api_key', apiKey)
  url.searchParams.set('file_type', 'json')
  url.searchParams.set('observation_start', formatDate(start))
  url.searchParams.set('observation_end', formatDate(end))

  const response = await fetch(url.toString())
  if (!response.ok) {
    console.error(`[economics] FRED API error for ${seriesId}: ${response.status} ${response.statusText}`)
    return 0
  }

  const json = (await response.json()) as FredResponse
  const observations = json.observations ?? []

  // Filter out missing values — FRED uses "." for unavailable data
  const rows = observations
    .filter((obs) => obs.value !== '.')
    .map((obs) => ({
      indicator_name: indicatorName,
      date: obs.date,
      value: parseFloat(obs.value),
      source: 'fred',
    }))

  if (rows.length === 0) return 0

  const supabase = createServiceClient()

  const { error } = await supabase
    .from('economic_indicators')
    .upsert(rows, { onConflict: 'indicator_name,date' })

  if (error) {
    console.error(`[economics] Upsert error for ${indicatorName}:`, error.message)
    return 0
  }

  return rows.length
}

// ---------------------------------------------------------------------------
// Fetch all series
// ---------------------------------------------------------------------------

/**
 * Fetch all tracked FRED series with a 500ms throttle between requests
 * to be respectful of the API.
 */
export async function fetchAllEconomicIndicators(): Promise<Record<string, number>> {
  const results: Record<string, number> = {}
  const entries = Object.entries(FRED_SERIES)

  for (let i = 0; i < entries.length; i++) {
    const [seriesId, indicatorName] = entries[i]
    const count = await fetchFredSeries(seriesId, indicatorName)
    results[indicatorName] = count

    // Throttle between requests (skip after last)
    if (i < entries.length - 1) {
      await sleep(500)
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Get latest indicator values
// ---------------------------------------------------------------------------

/**
 * Returns the most recent value for each tracked indicator from the database.
 */
export async function getLatestIndicators(): Promise<Record<string, number>> {
  const supabase = createServiceClient()
  const indicators: Record<string, number> = {}

  for (const indicatorName of Object.values(FRED_SERIES)) {
    const { data } = await supabase
      .from('economic_indicators')
      .select('value')
      .eq('indicator_name', indicatorName)
      .eq('source', 'fred')
      .order('date', { ascending: false })
      .limit(1)
      .single()

    if (data?.value != null) {
      indicators[indicatorName] = Number(data.value)
    }
  }

  return indicators
}

// ---------------------------------------------------------------------------
// Demand score calculation
// ---------------------------------------------------------------------------

// Historical averages — long-term FRED baselines used to normalize each
// indicator's current value into a "deviation from average" signal.
// Exported so the dashboard + market-pulse pages can use the same
// numbers; previously each surface had its own copy and any update to
// one drifted the others.
//
// Sources (rough averages, last 30 years):
//   consumer_sentiment       — UMCSENT mean ≈ 87, but recent decade
//                              skews lower; using 70 as the normal floor
//   personal_savings_rate    — PSAVERT 30y mean ≈ 7.5%
//   consumer_confidence      — CONCCONF index ≈ 100 (1985 = 100 by def)
//   housing_starts           — HOUST 1950–2020 mean ≈ 1.4M annualized
//   disposable_income_real   — DSPIC96 inflation-adjusted recent average
//
// These are NATIONAL economic baselines, not venue-specific. Don't make
// them per-venue config unless a venue explicitly opts into a custom
// regional baseline (which we don't support yet).
export const ECONOMIC_INDICATOR_AVERAGES: Record<string, number> = {
  consumer_sentiment: 70,
  personal_savings_rate: 7.5,
  consumer_confidence: 100,
  housing_starts: 1400,
  disposable_income_real: 15000,
}
const AVERAGES = ECONOMIC_INDICATOR_AVERAGES

/**
 * Composite economic signals into a 0–100 demand score.
 *
 * Baseline: 50
 *   Consumer sentiment trend vs average:     ±10
 *   Savings rate trend (inverted):           ± 5
 *   Consumer confidence trend vs average:    ± 8
 *   Housing starts trend:                    ± 5
 *
 * Higher score = stronger expected wedding demand.
 */
export function calculateDemandScore(indicators: Record<string, number>): DemandScore {
  let score = 50

  // Consumer sentiment — higher is better for spending
  if (indicators.consumer_sentiment != null) {
    const deviation = (indicators.consumer_sentiment - AVERAGES.consumer_sentiment) / AVERAGES.consumer_sentiment
    score += clamp(deviation * 20, -10, 10)
  }

  // Personal savings rate — inverted: lower savings = more spending = higher demand
  if (indicators.personal_savings_rate != null) {
    const deviation = (indicators.personal_savings_rate - AVERAGES.personal_savings_rate) / AVERAGES.personal_savings_rate
    score += clamp(-deviation * 10, -5, 5)
  }

  // Consumer confidence — higher is better
  if (indicators.consumer_confidence != null) {
    const deviation = (indicators.consumer_confidence - AVERAGES.consumer_confidence) / AVERAGES.consumer_confidence
    score += clamp(deviation * 16, -8, 8)
  }

  // Housing starts — proxy for new household formation
  if (indicators.housing_starts != null) {
    const deviation = (indicators.housing_starts - AVERAGES.housing_starts) / AVERAGES.housing_starts
    score += clamp(deviation * 10, -5, 5)
  }

  // Clamp final score to 0–100
  score = Math.round(clamp(score, 0, 100))

  const outlook: DemandScore['outlook'] =
    score >= 58 ? 'positive' : score >= 42 ? 'neutral' : 'caution'

  return { score, outlook }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
