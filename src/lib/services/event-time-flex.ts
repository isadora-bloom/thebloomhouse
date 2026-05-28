/**
 * Flexible event-datetime parser.
 *
 * Mirrors `parseFlexibleTourDatetime` originally embedded in
 * `lib/services/brain/inquiry.ts` (see the formatTourDateGuidance
 * helper that landed in commit c9e2a8c, 2026-05-27, for the
 * Caitlin "this Friday" bug). Extracted to a shared util so the
 * cohort executor + any future surface that needs to interpret
 * `engagement_events.metadata.event_datetime` can use the same
 * parser without duplicating regexes.
 *
 * Why it's needed: `scheduling-tool-parsers.ts` stores the
 * scheduling-tool's RAW event_datetime text verbatim, which can
 * be any of:
 *
 *   - ISO 8601 ("2026-06-05T13:15:00-04:00")
 *   - RFC 2822 ("Fri, 5 Jun 2026 13:15:00 -0400")
 *   - Long human date ("Friday, June 5, 2026, 1:15 PM")
 *   - Calendly raw ("01:15pm - Friday, June 5, 2026 (Eastern Time - US & Canada)")
 *
 * `Date.parse` handles the first three; the Calendly form returns NaN.
 * This helper falls back to regex extraction of month/day/year (+ time)
 * and reconstructs a Date in the runtime's local zone.
 */
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

const FLEX_DATE_RE = new RegExp(
  // optional leading time + dash: "01:15pm - "
  `(?:(\\d{1,2}):(\\d{2})\\s*(am|pm)?\\s*[-\\u2013\\u2014]?\\s*)?` +
    // optional weekday prefix: "Friday, "
    `(?:[A-Za-z]+,?\\s+)?` +
    // month day, year
    `(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`,
  'i',
)

export function parseFlexibleEventDatetime(
  value: string | null | undefined,
): Date | null {
  if (!value) return null
  const direct = new Date(value)
  if (!isNaN(direct.getTime())) return direct
  const m = value.match(FLEX_DATE_RE)
  if (!m) return null
  const [, hourS, minS, ampm, monthName, dayS, yearS] = m
  const monthIdx = MONTHS.indexOf(monthName.toLowerCase())
  if (monthIdx < 0) return null
  let hour = hourS ? parseInt(hourS, 10) : 12
  const minute = minS ? parseInt(minS, 10) : 0
  if (ampm) {
    const isPm = ampm.toLowerCase() === 'pm'
    if (isPm && hour < 12) hour += 12
    if (!isPm && hour === 12) hour = 0
  }
  const day = parseInt(dayS, 10)
  const year = parseInt(yearS, 10)
  const out = new Date(year, monthIdx, day, hour, minute)
  return isNaN(out.getTime()) ? null : out
}
