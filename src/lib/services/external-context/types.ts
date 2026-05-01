/**
 * External Context — shared types for the correlation engine (T2-C).
 *
 * The correlation engine reads multiple External Context channels and
 * tests for lagged Pearson correlations against the venue's inquiry /
 * booking metrics. Each channel speaks the same SeriesPoint shape:
 *   - dayKey: 'YYYY-MM-DD' (UTC date)
 *   - value: numeric value for that day
 *
 * Channels:
 *   - weather_data        — already exists (weather.ts service)
 *   - search_trends       — already exists (trends.ts service)
 *   - fred_indicators     — new (migration 138)
 *   - cultural_moments    — new (migration 139, propose-and-confirm)
 *   - external_calendar_events — new (migration 140)
 *
 * Per Playbook 17.4-A / T2-C.
 */

export interface SeriesPoint {
  dayKey: string  // 'YYYY-MM-DD'
  value: number
}

export type SeriesId = string  // e.g. 'fred_CPIAUCSL', 'calendar_federal_holiday', 'cultural_moments'

export interface ExternalChannelSeries {
  channel: SeriesId
  points: SeriesPoint[]
}

/**
 * Convert a Date to a UTC YYYY-MM-DD key. Matches the convention used
 * by correlation-engine.ts dayKey().
 */
export function toDayKey(d: Date): string {
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * Iterate every UTC day between start (inclusive) and end (inclusive).
 * Useful for projecting interval-shaped events (a week-long calendar
 * event, an ongoing cultural moment) onto per-day series points.
 */
export function* daysInRange(startDate: Date, endDate: Date): IterableIterator<string> {
  const cursor = new Date(Date.UTC(
    startDate.getUTCFullYear(),
    startDate.getUTCMonth(),
    startDate.getUTCDate(),
  ))
  const stop = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate(),
  )
  while (cursor.getTime() <= stop) {
    yield toDayKey(cursor)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
}
