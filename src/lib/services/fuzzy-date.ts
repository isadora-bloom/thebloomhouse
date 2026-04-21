/**
 * Fuzzy wedding-date parsing.
 *
 * The router-brain classifier returns whatever shape the couple used in
 * their email: "June 14, 2026" (great), "June" (just a month), "Fall 2026"
 * (a season + year), "late summer" (vague), "2026" (year only), or "6/14/26"
 * (slash-format). Naive `new Date(raw)` rejects most of the interesting
 * cases, which is why `weddings.wedding_date` stays null on inquiries
 * where the couple hasn't nailed a date down.
 *
 * This module returns a best-effort ISO date (YYYY-MM-DD) plus a
 * precision flag so callers can decide whether to store it on the wedding
 * row or just surface it in AI insights. We never invent specificity:
 * "Fall" maps to Oct 1, "Summer" to Jul 1, etc., flagged `season` so the
 * UI can render "Fall 2026" instead of "October 1".
 *
 * Philosophy: if the couple said "June" and today is April 2026, they
 * almost certainly mean June 2026. If they said "June" and today is
 * August 2026, they mean June 2027. Roll the year forward when the
 * implied month is in the past.
 */

export type DatePrecision = 'day' | 'month' | 'season' | 'year'

export interface FuzzyDate {
  iso: string          // YYYY-MM-DD — an ISO date suitable for DB storage
  precision: DatePrecision
  /** The original string we parsed, preserved for display fallbacks. */
  raw: string
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0,
  feb: 1, february: 1,
  mar: 2, march: 2,
  apr: 3, april: 3,
  may: 4,
  jun: 5, june: 5,
  jul: 6, july: 6,
  aug: 7, august: 7,
  sep: 8, sept: 8, september: 8,
  oct: 9, october: 9,
  nov: 10, november: 10,
  dec: 11, december: 11,
}

// Conventional mapping from season to a representative month (0-indexed).
// Northern-hemisphere. If we ever go international we'll parameterize.
const SEASONS: Record<string, number> = {
  spring: 3,   // April
  summer: 6,   // July
  fall: 9,     // October
  autumn: 9,
  winter: 0,   // January of the following year, handled below
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function isoFromYMD(y: number, m: number, d: number): string {
  // m is 0-indexed per JS Date convention.
  return `${y}-${pad2(m + 1)}-${pad2(d)}`
}

/**
 * Roll an implied month forward if it would otherwise be in the past
 * relative to `now`. Used when the couple said a bare month name.
 */
function yearForMonth(month: number, now: Date): number {
  const thisYear = now.getFullYear()
  const thisMonth = now.getMonth()
  // Weddings are planned 6-18 months out. If the target month has already
  // passed this year (or is this month), assume next year.
  return month <= thisMonth ? thisYear + 1 : thisYear
}

/**
 * Try the native parser first — handles ISO, "June 14, 2026", "6/14/26",
 * "2026-06-14T..." etc. Reject Invalid Date.
 */
function tryNativeParse(s: string, raw: string): FuzzyDate | null {
  const d = new Date(s)
  if (Number.isNaN(d.getTime())) return null
  // Heuristic: if the original string contained a day digit (1-31) OR a
  // slash, we got day-precision. Otherwise it's month precision.
  const hasDay = /\b([1-9]|[12]\d|3[01])\b/.test(s) || /[/-]/.test(s)
  return {
    iso: isoFromYMD(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    precision: hasDay ? 'day' : 'month',
    raw,
  }
}

/**
 * Parse strings like "June", "June 2026", "early June", "late June 2026".
 */
function tryMonthName(s: string, now: Date, raw: string): FuzzyDate | null {
  // Strip qualifier words that don't change the month.
  const cleaned = s.replace(/\b(early|mid|middle|late|end of|beginning of|start of)\b/g, ' ').trim()
  const yearMatch = cleaned.match(/\b(20\d{2}|\d{2})\b/)
  const monthMatch = cleaned.match(
    /\b(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|oct|nov|dec)\b/i
  )
  if (!monthMatch) return null

  const month = MONTHS[monthMatch[1].toLowerCase()]
  let year: number
  if (yearMatch) {
    const y = parseInt(yearMatch[1], 10)
    year = y < 100 ? 2000 + y : y
  } else {
    year = yearForMonth(month, now)
  }
  return {
    iso: isoFromYMD(year, month, 1),
    precision: 'month',
    raw,
  }
}

/**
 * Parse strings like "Fall 2026", "late summer", "winter 2026/2027".
 */
function trySeason(s: string, now: Date, raw: string): FuzzyDate | null {
  const seasonMatch = s.match(/\b(spring|summer|fall|autumn|winter)\b/i)
  if (!seasonMatch) return null
  const season = seasonMatch[1].toLowerCase()
  const month = SEASONS[season]
  const yearMatch = s.match(/\b(20\d{2})\b/)
  let year = yearMatch ? parseInt(yearMatch[1], 10) : yearForMonth(month, now)
  // Winter spans the year boundary; if the couple says "winter 2026" they
  // usually mean Jan-Feb 2026 OR Dec 2026, not both. Ambiguity is OK here
  // since precision='season' tells the UI not to pretend otherwise.
  if (season === 'winter' && !yearMatch) year = yearForMonth(0, now)
  return {
    iso: isoFromYMD(year, month, 1),
    precision: 'season',
    raw,
  }
}

/**
 * Year-only: "2026", "'26".
 */
function tryYearOnly(s: string, raw: string): FuzzyDate | null {
  const m = s.match(/^\s*'?(\d{2}|20\d{2})\s*$/)
  if (!m) return null
  const y = parseInt(m[1], 10)
  const year = y < 100 ? 2000 + y : y
  return {
    iso: isoFromYMD(year, 0, 1),
    precision: 'year',
    raw,
  }
}

/**
 * Main entrypoint. Returns null iff every strategy failed.
 * Pass `now` for testability; defaults to new Date().
 */
export function parseFuzzyDate(
  input: unknown,
  now: Date = new Date()
): FuzzyDate | null {
  if (input == null) return null
  const raw = String(input).trim()
  if (!raw) return null

  // Run the strategies in increasing fuzziness. Native first so "2026-06-14"
  // gets day-precision even though it would also match year-only regex.
  return (
    tryNativeParse(raw, raw) ??
    tryMonthName(raw, now, raw) ??
    trySeason(raw, now, raw) ??
    tryYearOnly(raw, raw) ??
    null
  )
}

/**
 * Convenience: just the ISO string, or null. For callers that don't need
 * the precision (e.g. writing to weddings.wedding_date).
 */
export function parseFuzzyDateIso(input: unknown, now?: Date): string | null {
  return parseFuzzyDate(input, now)?.iso ?? null
}

/**
 * Guest count parser — also belongs here since callers that need one
 * usually need the other. "150", "~150", "about 150 guests", "150-200"
 * (returns the low end), or null.
 */
export function parseGuestCount(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw)
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  const range = s.match(/(\d+)\s*[-–to]+\s*(\d+)/i)
  if (range) return parseInt(range[1], 10)
  const single = s.match(/\d+/)
  return single ? parseInt(single[0], 10) : null
}
