/**
 * Bloom House: Date Utilities
 *
 * Common date helpers using date-fns. Used across Agent, Intelligence,
 * and Portal for formatting wedding dates, calculating timelines, and
 * determining seasons.
 */

import {
  formatDistanceToNow,
  format,
  differenceInDays,
  isWeekend as dateFnsIsWeekend,
  parseISO,
} from 'date-fns'

// ---------------------------------------------------------------------------
// Parsing helper
// ---------------------------------------------------------------------------

function toDate(date: string | Date): Date {
  if (typeof date === 'string') return parseISO(date)
  return date
}

// ---------------------------------------------------------------------------
// Relative formatting
// ---------------------------------------------------------------------------

/**
 * Formats a date relative to now: "2 days ago", "in 3 weeks", "yesterday".
 */
export function formatRelative(date: string | Date): string {
  return formatDistanceToNow(toDate(date), { addSuffix: true })
}

// ---------------------------------------------------------------------------
// Wedding date formatting
// ---------------------------------------------------------------------------

/**
 * Formats a date for display as a wedding date: "Saturday, May 30, 2026".
 */
export function formatWeddingDate(date: string | Date): string {
  return format(toDate(date), 'EEEE, MMMM d, yyyy')
}

// ---------------------------------------------------------------------------
// Day calculations
// ---------------------------------------------------------------------------

/**
 * Number of days from now until the given date.
 * Returns a positive number for future dates, negative for past.
 */
export function daysUntil(date: string | Date): number {
  return differenceInDays(toDate(date), new Date())
}

/**
 * Number of days since the given date.
 * Returns a positive number for past dates, negative for future.
 */
export function daysSince(date: string | Date): number {
  return differenceInDays(new Date(), toDate(date))
}

// ---------------------------------------------------------------------------
// Season helpers
// ---------------------------------------------------------------------------

type Season = 'spring' | 'summer' | 'fall' | 'winter'

/**
 * Returns the current season based on the current month.
 */
export function getCurrentSeason(): Season {
  const month = new Date().getMonth() + 1 // 1-indexed
  return getSeasonFromMonth(month)
}

/**
 * Returns the season name for a given date.
 */
export function getWeddingSeason(date: string | Date): Season {
  const d = toDate(date)
  const month = d.getMonth() + 1 // 1-indexed
  return getSeasonFromMonth(month)
}

function getSeasonFromMonth(month: number): Season {
  if (month >= 3 && month <= 5) return 'spring'
  if (month >= 6 && month <= 8) return 'summer'
  if (month >= 9 && month <= 11) return 'fall'
  return 'winter'
}

// ---------------------------------------------------------------------------
// Weekend check
// ---------------------------------------------------------------------------

/**
 * Returns true if the given date falls on a Saturday or Sunday.
 */
export function isWeekend(date: string | Date): boolean {
  return dateFnsIsWeekend(toDate(date))
}
