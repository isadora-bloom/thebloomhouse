/**
 * FRED indicator series for the correlation engine (T2-C / Playbook 17.4-A).
 *
 * FRED = Federal Reserve Economic Data. https://fred.stlouisfed.org/
 * Each "series" is identified by a stable string id (CPIAUCSL = headline
 * CPI; MORTGAGE30US = 30-year fixed mortgage rate; SP500 = S&P 500 index).
 *
 * The default panel is what affects wedding-industry discretionary
 * spend most directly — venues can extend at runtime via
 * `loadFredSeries(seriesIds, ...)` if they want regional employment
 * or local CPI variants.
 *
 * Read path only — the writer is a cron-driven daily refresh
 * (scripts/fetch-fred-indicators.ts, follow-up scope) that hits
 * https://api.stlouisfed.org/fred/series/observations and upserts
 * into fred_indicators.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExternalChannelSeries, SeriesPoint } from './types'
import { toDayKey } from './types'

/**
 * Default FRED series the correlation engine pulls. These are the
 * macro indicators most causally connected to wedding-industry
 * discretionary spend per Playbook 17.4-A.
 */
export const DEFAULT_FRED_SERIES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'CPIAUCSL',     label: 'CPI (headline)' },
  { id: 'MORTGAGE30US', label: '30y fixed mortgage rate' },
  { id: 'SP500',        label: 'S&P 500' },
  { id: 'UNRATE',       label: 'US unemployment' },
  { id: 'UMCSENT',      label: 'Consumer sentiment' },
]

/**
 * Load FRED observations into per-day series points for the
 * correlation engine. Forward-fills missing days within the window
 * using the last observed value (FRED CPI is monthly; correlation
 * engine wants daily series so the lagged-correlation math has
 * dense rows).
 *
 * Per series → one ExternalChannelSeries with channel = `fred_<id>`.
 */
export async function loadFredSeries(
  supabase: SupabaseClient,
  windowStart: Date,
  windowEnd: Date,
  seriesIds: ReadonlyArray<string> = DEFAULT_FRED_SERIES.map((s) => s.id),
): Promise<ExternalChannelSeries[]> {
  if (seriesIds.length === 0) return []
  const startIso = windowStart.toISOString().slice(0, 10)
  const endIso = windowEnd.toISOString().slice(0, 10)

  const { data } = await supabase
    .from('fred_indicators')
    .select('series_id, observation_date, value')
    .in('series_id', seriesIds as string[])
    .gte('observation_date', startIso)
    .lte('observation_date', endIso)
    .order('observation_date', { ascending: true })

  type FredRow = { series_id: string; observation_date: string; value: number | null }
  const bySeriesRaw = new Map<string, Array<{ date: string; value: number }>>()
  for (const r of ((data ?? []) as FredRow[])) {
    if (r.value == null || !Number.isFinite(r.value)) continue
    const arr = bySeriesRaw.get(r.series_id) ?? []
    arr.push({ date: r.observation_date, value: r.value })
    bySeriesRaw.set(r.series_id, arr)
  }

  const out: ExternalChannelSeries[] = []
  for (const seriesId of seriesIds) {
    const raw = bySeriesRaw.get(seriesId) ?? []
    if (raw.length === 0) continue
    const sorted = [...raw].sort((a, b) => a.date.localeCompare(b.date))
    const points: SeriesPoint[] = []

    // Forward-fill into a per-day grid. FRED monthly series produce
    // ~12 observations per year; the correlation engine wants daily.
    let cursorIdx = 0
    let lastValue = sorted[0].value
    const cursor = new Date(windowStart)
    while (cursor <= windowEnd) {
      const dayKey = toDayKey(cursor)
      // Advance through observations whose date <= cursor.
      while (cursorIdx < sorted.length && sorted[cursorIdx].date <= dayKey) {
        lastValue = sorted[cursorIdx].value
        cursorIdx++
      }
      points.push({ dayKey, value: lastValue })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    out.push({ channel: `fred_${seriesId}`, points })
  }
  return out
}
