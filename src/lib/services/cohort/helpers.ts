/**
 * D9 cohort intelligence — shared helpers.
 *
 * Pagination, distribution stats, and timezone-aware date bucketing.
 * Every D9 feature module computes in TypeScript over rows loaded once
 * by data.ts; these are the primitives they share.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Distribution } from './types'
import { MIN_DISTRIBUTION_N } from './types'

const PAGE = 1000

/**
 * Drain every row matching a PostgREST query. The caller supplies a
 * factory that builds the base query (table + select + filters); this
 * loops `.range()` until a short page comes back. Couple/touchpoint
 * counts at Rixey scale (~2K / ~4K) fit in memory comfortably; this is
 * the safety net against the implicit 1000-row PostgREST cap.
 */
export async function fetchAllRows<T>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeQuery: () => any,
): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await makeQuery().range(from, from + PAGE - 1)
    if (error) throw new Error(`[cohort] fetch failed: ${error.message}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

export type SupabaseLike = SupabaseClient

// ---------------------------------------------------------------------------
// Distribution stats
// ---------------------------------------------------------------------------

/** Linear-interpolated percentile over an ascending-sorted array. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null
  if (sortedAsc.length === 1) return sortedAsc[0]
  const rank = (p / 100) * (sortedAsc.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  if (lo === hi) return sortedAsc[lo]
  const frac = rank - lo
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * frac
}

/**
 * Summarise a set of numeric observations into a Distribution. Values
 * need not be pre-sorted. `enoughData` gates whether a surface should
 * render the median as a fact (doctrine §C.6 Tier-4 honesty).
 */
export function summarize(values: number[]): Distribution {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  const n = clean.length
  if (n === 0) {
    return {
      n: 0,
      enoughData: false,
      min: null,
      p25: null,
      median: null,
      p75: null,
      p90: null,
      max: null,
      mean: null,
    }
  }
  const mean = clean.reduce((s, v) => s + v, 0) / n
  return {
    n,
    enoughData: n >= MIN_DISTRIBUTION_N,
    min: clean[0],
    p25: percentile(clean, 25),
    median: percentile(clean, 50),
    p75: percentile(clean, 75),
    p90: percentile(clean, 90),
    max: clean[n - 1],
    mean: round2(mean),
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Safe ratio — null when the denominator is zero (never 0/0 = NaN,
 *  never a fake 0%). */
export function ratio(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return round2(numerator / denominator)
}

// ---------------------------------------------------------------------------
// Timezone-aware date parts
// ---------------------------------------------------------------------------

export interface ZonedParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  weekday: number // 0 = Sunday .. 6 = Saturday
  dateKey: string // 'YYYY-MM-DD' in venue local time
  monthKey: string // 'YYYY-MM'
}

const FMT_CACHE = new Map<string, Intl.DateTimeFormat>()
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
}

function formatter(tz: string): Intl.DateTimeFormat {
  let f = FMT_CACHE.get(tz)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
        weekday: 'short',
      })
    } catch {
      // Bad/unknown tz string — fall back to UTC.
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: 'UTC',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hour12: false,
        weekday: 'short',
      })
    }
    FMT_CACHE.set(tz, f)
  }
  return f
}

/** Decompose an ISO timestamp into venue-local calendar parts. */
export function zonedParts(iso: string, tz: string): ZonedParts | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const parts = formatter(tz).formatToParts(new Date(ms))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  const year = Number(get('year'))
  const month = Number(get('month'))
  const day = Number(get('day'))
  // Intl renders midnight as '24' in some engines — normalise.
  const rawHour = Number(get('hour'))
  const hour = rawHour === 24 ? 0 : rawHour
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0
  if (!year || !month || !day) return null
  const mm = String(month).padStart(2, '0')
  const dd = String(day).padStart(2, '0')
  return {
    year,
    month,
    day,
    hour,
    weekday,
    dateKey: `${year}-${mm}-${dd}`,
    monthKey: `${year}-${mm}`,
  }
}

/** Northern-hemisphere meteorological season from a 1-12 month. */
export function season(month: number): 'winter' | 'spring' | 'summer' | 'fall' {
  if (month === 12 || month <= 2) return 'winter'
  if (month <= 5) return 'spring'
  if (month <= 8) return 'summer'
  return 'fall'
}

export function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6
}

export const WEEKDAY_LABEL = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

export const MONTH_LABEL = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * Major US holiday windows for "holiday inquiry spike" analysis (Q7).
 * Returns a window label when the month/day falls inside a recognised
 * window, else null. Windows are deliberately wide (a few days either
 * side) — couples browse venues around holidays, not on the day.
 */
export function holidayWindow(month: number, day: number): string | null {
  // New Year (engagement season peak): Dec 26 - Jan 7
  if ((month === 12 && day >= 26) || (month === 1 && day <= 7))
    return "New Year's"
  // Valentine's: Feb 10 - Feb 18
  if (month === 2 && day >= 10 && day <= 18) return "Valentine's"
  // Memorial Day-ish: May 24 - May 31
  if (month === 5 && day >= 24) return 'Late May'
  // July 4: Jul 1 - Jul 7
  if (month === 7 && day >= 1 && day <= 7) return 'July 4th'
  // Labor Day-ish: Sep 1 - Sep 8
  if (month === 9 && day >= 1 && day <= 8) return 'Labor Day'
  // Thanksgiving window: Nov 20 - Nov 30
  if (month === 11 && day >= 20) return 'Thanksgiving'
  return null
}

/** Median of a numeric list, or null when empty. */
export function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  return percentile(clean, 50)
}
