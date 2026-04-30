/**
 * Event-time helpers.
 *
 * Background: 2026-04-30 we discovered a systemic pattern where
 * temporal fields (inquiry_date, occurred_at, signal_date, posted_at,
 * review_date, interactions.timestamp) were being stamped to
 * wall-clock NOW() or to an EVENT_ARRIVAL proxy (email.date) when the
 * actual SOURCE-EVENT TIME was available in scope. The bug was
 * invisible during real-time operations (NOW ≈ event arrival) but
 * catastrophic on backfills, batch imports, and Calendly notification
 * emails — Rixey lost 41 cross-platform attributions to it because
 * 77 of 83 Knot-sourced weddings had inquiry_date stamped to a
 * single batch-import day, breaking ±72h matching.
 *
 * The fix is structural: every writer of a semantic-event temporal
 * field uses these helpers so the bad pattern can't sneak back in.
 *
 * Two functions:
 *   - parseEventTime: parse a string into ISO-or-null. NEVER falls
 *     back to NOW. The caller decides what to do with null
 *     (skip the row, surface an error, use a different source).
 *   - chooseEventTime: given an ordered list of candidate sources,
 *     return the first that parses. Useful for the common pattern
 *     "prefer X but fall back to Y" — e.g. tour eventDatetime, then
 *     email arrival, then null.
 *
 * Why null instead of NOW:
 *   - NOW silently corrupts backfilled / imported data
 *   - explicit null forces the caller to decide
 *   - downstream readers can detect / filter null cleanly; can't
 *     detect a NOW that should have been a real timestamp
 */

/**
 * Parse a temporal value into a UTC ISO string. Returns null when
 * input is empty, null, undefined, or unparseable. Never falls back
 * to wall-clock NOW.
 *
 * Accepts the same inputs `new Date()` accepts: RFC-2822 ("Wed, 10
 * Mar 2026 14:23:11 -0500"), ISO ("2026-04-13T18:00:00Z"), and date-
 * only strings ("2026-04-13" → midnight UTC). For vendor-CSV formats
 * use parseVendorDate from ./parse-vendor-date.ts instead — it
 * handles non-ISO formats this function rejects.
 */
export function parseEventTime(value: string | null | undefined): string | null {
  if (!value) return null
  const d = new Date(value)
  if (isNaN(d.getTime())) return null
  return d.toISOString()
}

/**
 * Walk an ordered list of candidate source values and return the
 * first that parses cleanly. Use this when a writer has multiple
 * possible sources of truth and wants to prefer the most-precise
 * one (e.g. Calendly's tour eventDatetime over the notification
 * email's arrival timestamp).
 *
 * Returns null when ALL candidates fail. Caller decides: skip the
 * row, log the error, write null and accept a NULL field, etc.
 */
export function chooseEventTime(...candidates: Array<string | null | undefined>): string | null {
  for (const c of candidates) {
    const parsed = parseEventTime(c)
    if (parsed !== null) return parsed
  }
  return null
}
