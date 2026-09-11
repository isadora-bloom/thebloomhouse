/**
 * Back-derive a real timestamp from the relative age a social UI shows.
 *
 * Wave 3, HANDLE-IDENTITY-SPEC.md §4. The capture surfaces never give us
 * an absolute time. Instagram writes "2d", TikTok writes "1w", a
 * notifications list writes "May 04" once a row is older than a few
 * weeks. The vision extractor copies that string out verbatim
 * (`SocialVisionRow.relative_age`, vision-prompt.ts) and this is the
 * downstream parser that turns it into an `occurred_at` the spine can
 * order against email, Calendly and the tour.
 *
 * Everything is anchored on the capture time, not on `Date.now()`, so a
 * replay run months later derives exactly the same instant it derived
 * the first time. That matters: `external_id` carries the capture date,
 * so a drifting anchor would mint a second touchpoint for one follow.
 *
 * Shapes handled:
 *
 *   "now", "just now", "today"     -> the capture instant
 *   "2m", "2 min", "2 minutes ago" -> minutes back
 *   "3h", "3 hours ago"            -> hours back
 *   "2d", "2 days ago", "yesterday"-> days back
 *   "1w", "1 week ago"             -> weeks back
 *   "5mo", "5 months ago"          -> months back
 *   "2y", "2 years ago"            -> years back
 *   "May 04", "4 May"              -> that day, the most recent one
 *                                     at or before the capture
 *   "Mar 2026", "March 2026"       -> the first of that month
 *   "2026-05-04"                   -> that day
 *
 * Precision travels with the answer. A follower row that only said "1w"
 * is not a Tuesday afternoon, and a reader that treats it as one will
 * draw a ribbon it cannot defend. The caller stores the precision in the
 * signal's raw payload.
 */

export type SocialDatePrecision = 'exact' | 'hour' | 'day' | 'month' | 'year'

export interface DerivedSocialDate {
  /** ISO 8601 instant. */
  occurred_at: string
  /** How much of that instant is real, and how much is the anchor. */
  precision: SocialDatePrecision
  /** The string this came from, kept for the raw payload. */
  source: string
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

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/** Unit suffixes as the platforms abbreviate them. Order matters: "mo"
 *  has to be tested before "m", or five months reads as five minutes. */
const UNITS: Array<{ keys: string[]; ms: number; precision: SocialDatePrecision }> = [
  { keys: ['mo', 'mos', 'month', 'months'], ms: 30 * DAY, precision: 'month' },
  { keys: ['y', 'yr', 'yrs', 'year', 'years'], ms: 365 * DAY, precision: 'year' },
  { keys: ['w', 'wk', 'wks', 'week', 'weeks'], ms: WEEK, precision: 'day' },
  { keys: ['d', 'day', 'days'], ms: DAY, precision: 'day' },
  { keys: ['h', 'hr', 'hrs', 'hour', 'hours'], ms: HOUR, precision: 'hour' },
  { keys: ['m', 'min', 'mins', 'minute', 'minutes'], ms: MINUTE, precision: 'exact' },
  { keys: ['s', 'sec', 'secs', 'second', 'seconds'], ms: 1000, precision: 'exact' },
]

function unitFor(token: string): { ms: number; precision: SocialDatePrecision } | null {
  for (const u of UNITS) {
    if (u.keys.includes(token)) return { ms: u.ms, precision: u.precision }
  }
  return null
}

/**
 * Turn a relative-age string into an instant, anchored on `capturedAt`.
 * Returns null when the string says nothing we can trust; the caller
 * then falls back to the capture time and records that it did.
 */
export function parseRelativeAge(
  raw: string | null | undefined,
  capturedAt: string | Date,
): DerivedSocialDate | null {
  if (!raw) return null
  const anchor = capturedAt instanceof Date ? capturedAt : new Date(capturedAt)
  if (Number.isNaN(anchor.getTime())) return null

  const text = raw.trim().toLowerCase()
  if (!text) return null

  // "now" / "just now" / "today" / "yesterday".
  if (text === 'now' || text === 'just now' || text === 'a moment ago') {
    return { occurred_at: anchor.toISOString(), precision: 'exact', source: raw }
  }
  if (text === 'today') {
    return { occurred_at: anchor.toISOString(), precision: 'day', source: raw }
  }
  if (text === 'yesterday') {
    return {
      occurred_at: new Date(anchor.getTime() - DAY).toISOString(),
      precision: 'day',
      source: raw,
    }
  }

  // ISO date, or anything Date already understands in YYYY-MM-DD form.
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
    return Number.isNaN(d.getTime())
      ? null
      : { occurred_at: d.toISOString(), precision: 'day', source: raw }
  }

  // "2d", "2 d", "2 days", "2 days ago", "about 2 days ago".
  const rel = /(\d+)\s*([a-z]+)/.exec(text)
  if (rel) {
    const n = Number(rel[1])
    const unit = unitFor(rel[2])
    if (unit && Number.isFinite(n) && n >= 0) {
      // A month or a year is not a fixed number of milliseconds. Step the
      // calendar instead so "5mo" from 31 March lands in a real October.
      if (unit.precision === 'month' || unit.precision === 'year') {
        const d = new Date(anchor.getTime())
        if (unit.precision === 'month') d.setUTCMonth(d.getUTCMonth() - n)
        else d.setUTCFullYear(d.getUTCFullYear() - n)
        return { occurred_at: d.toISOString(), precision: unit.precision, source: raw }
      }
      return {
        occurred_at: new Date(anchor.getTime() - n * unit.ms).toISOString(),
        precision: unit.precision,
        source: raw,
      }
    }
  }

  // "May 04" / "4 May" / "May 4 2025" / "March 2026".
  const monthDay = /^([a-z]{3,9})\.?\s+(\d{1,4})(?:,?\s*(\d{4}))?$/.exec(text)
  const dayMonth = /^(\d{1,2})\s+([a-z]{3,9})\.?(?:,?\s*(\d{4}))?$/.exec(text)

  if (monthDay && MONTHS[monthDay[1]] !== undefined) {
    const month = MONTHS[monthDay[1]]
    const second = Number(monthDay[2])
    const third = monthDay[3] ? Number(monthDay[3]) : null
    // "Mar 2026" — a bare four-digit number after the month is a year.
    if (!third && second >= 1000) {
      return {
        occurred_at: new Date(Date.UTC(second, month, 1)).toISOString(),
        precision: 'month',
        source: raw,
      }
    }
    return { occurred_at: resolveDay(anchor, month, second, third), precision: 'day', source: raw }
  }

  if (dayMonth && MONTHS[dayMonth[2]] !== undefined) {
    const month = MONTHS[dayMonth[2]]
    const day = Number(dayMonth[1])
    const year = dayMonth[3] ? Number(dayMonth[3]) : null
    return { occurred_at: resolveDay(anchor, month, day, year), precision: 'day', source: raw }
  }

  return null
}

/**
 * A month and a day with no year is the most recent such day at or
 * before the capture. Instagram only drops the year once the row is old,
 * so "May 04" captured in March means May of the year before.
 */
function resolveDay(anchor: Date, month: number, day: number, year: number | null): string {
  if (year !== null) {
    return new Date(Date.UTC(year, month, day)).toISOString()
  }
  const candidate = new Date(Date.UTC(anchor.getUTCFullYear(), month, day))
  if (candidate.getTime() > anchor.getTime()) {
    candidate.setUTCFullYear(candidate.getUTCFullYear() - 1)
  }
  return candidate.toISOString()
}
