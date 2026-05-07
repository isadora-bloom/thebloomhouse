/**
 * Bloom House: Demand-score calculation against `fred_indicators`.
 *
 * Tier-B #80 (2026-05-08): replaces the legacy `services/economics.ts`
 * which read the deprecated `economic_indicators` table. This module
 * reads the canonical `fred_indicators` table (series_id +
 * observation_date schema, populated by the cron via
 * `external-context/fred-fetch.ts`).
 *
 * The 4 importers (briefings, draft-context-summary, sage-intelligence,
 * intel/dashboard) all wanted the same shape:
 *   1. Latest snapshot of UMCSENT / PSAVERT / DSPIC96 / HOUST / CONCCONF
 *      keyed by a stable semantic name.
 *   2. A composite 0-100 demand score with positive / neutral / caution
 *      outlook.
 *   3. The historical baselines used for normalization (so each surface
 *      can show "deviation from average" if it wants).
 *
 * This module exports those exact three things so the migration is a
 * pure rename at the call site (no behavioral change beyond data
 * source). After the four importers migrate, services/economics.ts
 * gets deleted in the same commit.
 */

import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Series-id → semantic name mapping
// ---------------------------------------------------------------------------
//
// FRED series ids are opaque strings (UMCSENT, PSAVERT, etc). The
// demand-score callers want semantic names (consumer_sentiment,
// personal_savings_rate). This map is the only place the bridge lives.

const SERIES_TO_NAME: Record<string, string> = {
  UMCSENT: 'consumer_sentiment',
  PSAVERT: 'personal_savings_rate',
  DSPIC96: 'disposable_income_real',
  HOUST: 'housing_starts',
  CONCCONF: 'consumer_confidence',
}

const TRACKED_SERIES_IDS = Object.keys(SERIES_TO_NAME)

// ---------------------------------------------------------------------------
// Historical baselines
// ---------------------------------------------------------------------------
//
// Long-term FRED averages used to normalize each indicator's current
// value into a "deviation from average" signal. Sourced from rough
// 30-year means; intentional to keep them as a single constant rather
// than per-venue config — these are NATIONAL macro baselines, not
// venue-specific.
//
// Sources:
//   consumer_sentiment       UMCSENT mean ≈ 87, recent decade lower ≈ 70
//   personal_savings_rate    PSAVERT 30y mean ≈ 7.5%
//   consumer_confidence      CONCCONF index ≈ 100 (1985 = 100 by def)
//   housing_starts           HOUST 1950–2020 mean ≈ 1.4M annualized
//   disposable_income_real   DSPIC96 inflation-adjusted recent average

export const ECONOMIC_INDICATOR_AVERAGES: Record<string, number> = {
  consumer_sentiment: 70,
  personal_savings_rate: 7.5,
  consumer_confidence: 100,
  housing_starts: 1400,
  disposable_income_real: 15000,
}

const AVERAGES = ECONOMIC_INDICATOR_AVERAGES

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DemandScore {
  score: number
  outlook: 'positive' | 'neutral' | 'caution'
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

/**
 * Returns the most recent value for each tracked indicator, keyed by
 * the semantic name (consumer_sentiment etc). Reads from
 * `fred_indicators` (series_id + observation_date); the cron writer
 * upserts there via DEFAULT_FRED_SERIES in external-context/fred.ts.
 *
 * Indicators with no observations return absent — the calling
 * demand-score path treats them as "no signal" (no contribution to
 * the score).
 *
 * One round trip: pulls all rows for the tracked series in a single
 * IN query, sorts client-side, picks the most-recent per series.
 * Avoids the N-roundtrip pattern the legacy module had.
 */
export async function getLatestIndicators(): Promise<Record<string, number>> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from('fred_indicators')
    .select('series_id, observation_date, value')
    .in('series_id', TRACKED_SERIES_IDS)
    .order('observation_date', { ascending: false })

  if (error) {
    console.warn('[fred-demand] getLatestIndicators read failed:', error.message)
    return {}
  }

  const latest: Record<string, number> = {}
  for (const row of (data ?? []) as Array<{
    series_id: string
    observation_date: string
    value: number | string | null
  }>) {
    const semantic = SERIES_TO_NAME[row.series_id]
    if (!semantic || latest[semantic] !== undefined) continue
    if (row.value === null) continue
    const numeric = typeof row.value === 'string' ? parseFloat(row.value) : row.value
    if (!Number.isFinite(numeric)) continue
    latest[semantic] = numeric
  }
  return latest
}

// ---------------------------------------------------------------------------
// Demand-score composite
// ---------------------------------------------------------------------------

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
 *
 * Behaviour identical to the legacy economics.ts version (this is a
 * direct port; no scoring change). The differences are read source
 * (fred_indicators vs economic_indicators) and series-id naming
 * (handled by getLatestIndicators).
 */
export function calculateDemandScore(indicators: Record<string, number>): DemandScore {
  let score = 50

  if (indicators.consumer_sentiment != null) {
    const deviation =
      (indicators.consumer_sentiment - AVERAGES.consumer_sentiment) /
      AVERAGES.consumer_sentiment
    score += clamp(deviation * 20, -10, 10)
  }

  // Savings rate inverted: lower savings → more discretionary spend → higher demand.
  if (indicators.personal_savings_rate != null) {
    const deviation =
      (indicators.personal_savings_rate - AVERAGES.personal_savings_rate) /
      AVERAGES.personal_savings_rate
    score += clamp(-deviation * 10, -5, 5)
  }

  if (indicators.consumer_confidence != null) {
    const deviation =
      (indicators.consumer_confidence - AVERAGES.consumer_confidence) /
      AVERAGES.consumer_confidence
    score += clamp(deviation * 16, -8, 8)
  }

  if (indicators.housing_starts != null) {
    const deviation =
      (indicators.housing_starts - AVERAGES.housing_starts) / AVERAGES.housing_starts
    score += clamp(deviation * 10, -5, 5)
  }

  score = Math.round(clamp(score, 0, 100))
  const outlook: DemandScore['outlook'] =
    score >= 58 ? 'positive' : score >= 42 ? 'neutral' : 'caution'
  return { score, outlook }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
