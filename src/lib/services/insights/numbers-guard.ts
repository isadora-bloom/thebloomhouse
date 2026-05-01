/**
 * Post-generation numbers-guard for T3 insight narrations.
 * Per Tier 3 audit gate: "No LLM-produced numbers in any surfaced
 * insight (post-generation regex assertion)."
 *
 * Reason: an LLM can hallucinate convincing numbers ("conversion
 * dropped 23%" when the actual number is 7%). The architecture
 * separates classical compute (the numbers) from LLM narration (the
 * reasoning). This guard runs after the LLM call and asserts the
 * narration only references numbers the classical pass produced.
 *
 * The guard is a regex sweep — it pulls every numeric token from the
 * narration and checks each against the classical evidence's
 * `numbers` allowlist. Tokens not in the allowlist trip a violation.
 *
 * Tolerated false-friends:
 *   - "1-2 sentences", "first / second", "one couple" — pure-word
 *     numerals don't trip
 *   - "April", "Q3", "2026" — month / quarter / year tokens that
 *     aren't quantitative claims
 *   - "100%" appearing in stock phrases that don't make a numeric
 *     claim (e.g. "couple is 100% committed") — caller can pass
 *     `tolerateRoundPercents: true` for these
 *
 * Usage:
 *   const violations = checkNarrationNumbers(narration.body, classical)
 *   if (violations.length > 0) {
 *     // log + reject narration; caller can re-prompt or fall back to
 *     // a deterministic template
 *   }
 */

import type { ClassicalEvidence } from './types'

export interface NumbersGuardViolation {
  /** The unauthorized numeric token from the narration. */
  token: string
  /** Where in the narration it appeared (char index). */
  index: number
}

// Numeric token shapes:
//   - 12, 12.5, 12,000, 12,000.50, 2026
//   - $5,000, $1.2M
//   - 50%, 50.5%, 12pp
//   - 12x, 2.5×
//   - 12 days, 12-day, twelve days (twelve handled separately, see allowedWords)
//
// First branch handles comma-grouped numbers (5,000 / 12,000.50). Second
// branch handles bare digit runs of any length (2026, 100, 65). Both
// can have a unit suffix. Pre-fix `\d{1,3}` would split "2026" into
// "202" + "6" which then both failed year-detection.
const NUMERIC_TOKEN = /\$?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?:%|pp|x|×|[a-z]+)?/gi

// Word numerals "one"/"two"/etc. up to "ten" and a handful of common
// rounded magnitudes. The narrator uses these for prose ("one
// coordinator", "two months"); they're never quantitative claims that
// could be wrong, so allow without checking against classical.
const WORD_NUMERAL_ALLOWLIST = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'first', 'second', 'third', 'fourth', 'fifth',
  'a', 'an', 'the', 'every', 'each', 'most', 'some', 'few', 'several',
])

// Calendar tokens ("April", "Q3", "2026") that look numeric but
// aren't quantitative. Standalone year-shape tokens (4 digits in
// 19xx-20xx range) get whitelisted because they don't make a
// quantitative claim.
const MONTH_TOKEN = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)$/i
const QUARTER_TOKEN = /^q[1-4]$/i
const YEAR_TOKEN = /^(19|20)\d{2}$/

function isYearOrCalendarToken(token: string): boolean {
  if (MONTH_TOKEN.test(token)) return true
  if (QUARTER_TOKEN.test(token)) return true
  if (YEAR_TOKEN.test(token)) return true
  return false
}

function normaliseNumericToken(t: string): string[] {
  // Produce multiple forms a classical number could match against.
  // Classical evidence might say `5000` while narration says `$5,000`
  // or `5,000`. All three should match.
  const variants = new Set<string>()
  const lower = t.toLowerCase()
  variants.add(lower)
  // Strip $, commas, units
  const stripped = lower
    .replace(/^\$/, '')
    .replace(/,/g, '')
    .replace(/(%|pp|x|×|days?|weeks?|months?|hours?|minutes?|years?)$/i, '')
    .trim()
  if (stripped) variants.add(stripped)
  // Numeric form (parseFloat of stripped)
  const num = Number(stripped)
  if (Number.isFinite(num)) {
    variants.add(String(num))
    if (Number.isInteger(num)) variants.add(String(Math.round(num)))
  }
  return Array.from(variants)
}

function buildAllowlist(classical: ClassicalEvidence): Set<string> {
  const out = new Set<string>()
  for (const n of classical.numbers) {
    const variants = normaliseNumericToken(String(n))
    for (const v of variants) out.add(v)
  }
  // Always allow 0/0% — a "no change detected" narration legitimately
  // uses these even when not in classical.numbers.
  out.add('0')
  out.add('0%')
  return out
}

export interface CheckOptions {
  /** Allow round percentages like "100%", "50%" even if not in
   *  classical.numbers. They appear in stock phrases ("100% sure",
   *  "the venue's 50% non-refundable retainer"). Default: true. */
  tolerateRoundPercents?: boolean
}

export function checkNarrationNumbers(
  narration: string,
  classical: ClassicalEvidence,
  opts: CheckOptions = {},
): NumbersGuardViolation[] {
  const tolerateRoundPercents = opts.tolerateRoundPercents ?? true
  const allowed = buildAllowlist(classical)
  const violations: NumbersGuardViolation[] = []

  // Iterate via matchAll so we can capture indexes.
  for (const m of narration.matchAll(NUMERIC_TOKEN)) {
    const token = m[0]
    const idx = m.index ?? -1
    const lower = token.toLowerCase()

    // Skip word numerals (the regex doesn't match them, but explicit).
    if (WORD_NUMERAL_ALLOWLIST.has(lower)) continue

    // Skip calendar tokens.
    if (isYearOrCalendarToken(token)) continue

    // Tolerate round percentages ("100%", "50%", "25%", etc.) when the
    // option is on.
    if (tolerateRoundPercents && /^\d{1,3}%$/.test(token) && Number(token.slice(0, -1)) % 25 === 0) {
      continue
    }

    // Allowlist check.
    const variants = normaliseNumericToken(token)
    const matched = variants.some((v) => allowed.has(v))
    if (!matched) {
      violations.push({ token, index: idx })
    }
  }

  return violations
}
