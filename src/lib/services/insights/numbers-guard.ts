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
 *
 * --- Invented-confidence detection (T5-followup-X, 2026-05-02) ----------------
 *
 * Beyond bare numbers, a second class of hallucination is invented
 * CONFIDENCE / CERTAINTY framing. Two flavours:
 *
 *   1. Quantitative confidence: "I'm 87% confident this lead will book."
 *      The 87% must trace to classical.numbers (a Pearson r, a cohort
 *      match rate, etc.). If not present, the bare-number guard catches
 *      it on the trailing %; we ALSO catch the CLAIM phrase explicitly
 *      so a future LLM "5% confident" (a number that happens to match
 *      classical.numbers but is being abused as a confidence claim)
 *      still trips a violation. Caller can opt out via
 *      tolerateConfidenceClaims=true if they have a real classical
 *      confidence number to surface.
 *
 *   2. Qualitative absolute certainty: "guaranteed", "definitely will
 *      book", "certainly", "we're sure", "will absolutely". The platform
 *      should never claim certainty about a probabilistic outcome — that's
 *      both factually wrong (no model has 100% recall) and a regulatory
 *      risk (overpromising). These ALWAYS reject.
 *
 *   3. Hedged language is fine: "likely", "may", "tends to", "often",
 *      "could indicate", "suggests". The narrator NEEDS room to talk
 *      about probability without becoming overly conservative.
 */

import type { ClassicalEvidence } from './types'

export interface NumbersGuardViolation {
  /** The unauthorized numeric token from the narration. */
  token: string
  /** Where in the narration it appeared (char index). */
  index: number
  /** Why this tripped — defaults to 'invented_number' for the legacy
   *  bare-number path. The new confidence checks emit
   *  'invented_confidence' / 'absolute_certainty' so callers can
   *  log/handle them differently. */
  kind?: 'invented_number' | 'invented_confidence' | 'absolute_certainty'
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
  /** Allow numeric confidence claims ("87% confident") when the caller
   *  has a real classical confidence number to surface. Default: false.
   *  When false, ANY phrase shaped like "<X>% confident / sure /
   *  certain / probability / chance / likely" is treated as an invented
   *  confidence violation regardless of whether <X> is in
   *  classical.numbers. Reason: even a number that's classically
   *  present (e.g. a Pearson r * 100) is being abused as a
   *  forward-looking certainty claim, which the platform shouldn't
   *  make. Surface designers who really need to expose a confidence
   *  number should pass tolerateConfidenceClaims=true AND ensure the
   *  number is in classical.numbers. */
  tolerateConfidenceClaims?: boolean
}

// ---------------------------------------------------------------------------
// Invented-confidence detection (T5-followup-X)
// ---------------------------------------------------------------------------

// Quantitative confidence claim: "<NUM>% confident / sure / certain /
// probability / chance / likely". Captures the numeric token + the
// claim word so the violation reporting is meaningful. Word-boundary on
// the claim noun avoids matching "likely" inside other words.
//
// We deliberately allow words like "likely" through the bare-number
// guard but trip them HERE when prefixed by an explicit percentage,
// because that's the LLM smuggling a fake precision past hedged framing
// ("85% likely" reads as a real number even though no model produced
// it).
const QUANTITATIVE_CONFIDENCE_RE =
  /(\d+(?:\.\d+)?)\s*%\s+(?:confiden(?:t|ce)|sure|certain|probability|chance|likely|likelihood)\b/gi

// Qualitative absolute-certainty claims. These ALWAYS reject — the
// platform is a probabilistic recommender, not an oracle. The list is
// hand-curated to catch real LLM patterns without false-positives on
// legitimate hedged prose:
//
//   - "guaranteed" / "guarantees" — promises an outcome
//   - "definitely will" / "will definitely" — same energy
//   - "certainly will" / "will certainly"
//   - "absolutely will" / "will absolutely"
//   - "100% sure" / "100% certain" / "100% confident" — numeric absolute
//   - "nearly certain" / "near certainty"
//   - "we're sure" / "we are sure" / "I'm sure" / "I am sure"
//   - "no doubt" / "without doubt" / "without a doubt"
//   - "this lead WILL book" — uppercase WILL is an LLM tic; the
//     auto-aware regex below catches the lowercase too via the
//     definitely/certainly set, so we don't need a separate "will book"
//     pattern (which would false-positive on "they will book a tour
//     next week" hedged prose).
//
// Each entry runs as a case-insensitive regex; \b ensures whole-word
// matches.
const ABSOLUTE_CERTAINTY_PATTERNS: RegExp[] = [
  // "guarantee" / "guaranteed" / "guarantees" — single regex covers all
  // three via /\bguarantee(?:d|s)?\b/.
  /\bguarantee(?:d|s)?\b/i,
  /\b(definitely|certainly|absolutely)\s+will\b/i,
  /\bwill\s+(definitely|certainly|absolutely)\b/i,
  /\b100\s*%\s+(sure|certain|confident|guaranteed)\b/i,
  /\bnearly\s+certain\b/i,
  /\bnear\s+certainty\b/i,
  /\b(we'?re|we\s+are|i'?m|i\s+am)\s+(sure|certain|confident)\b/i,
  /\bno\s+doubt\b/i,
  /\bwithout\s+(a\s+)?doubt\b/i,
  /\b(beyond|past)\s+(any\s+)?doubt\b/i,
]

/**
 * Detect invented confidence/certainty framing in narration text.
 *
 * Returns violations for:
 *   - Quantitative confidence claims (kind='invented_confidence') unless
 *     tolerateConfidenceClaims=true.
 *   - Qualitative absolute-certainty phrases (kind='absolute_certainty')
 *     always.
 *
 * Hedged language ("likely", "may", "tends to", "could indicate",
 * "often", "frequently") passes through untouched.
 */
function checkConfidenceClaims(
  narration: string,
  opts: CheckOptions,
): NumbersGuardViolation[] {
  const violations: NumbersGuardViolation[] = []

  if (!opts.tolerateConfidenceClaims) {
    for (const m of narration.matchAll(QUANTITATIVE_CONFIDENCE_RE)) {
      violations.push({
        token: m[0].trim(),
        index: m.index ?? -1,
        kind: 'invented_confidence',
      })
    }
  }

  for (const re of ABSOLUTE_CERTAINTY_PATTERNS) {
    // Each pattern is non-global (no /g flag), so re.exec is stateless
    // and re-callable on the same regex literal across narrations.
    const m = re.exec(narration)
    if (m) {
      violations.push({
        token: m[0],
        index: m.index ?? -1,
        kind: 'absolute_certainty',
      })
    }
  }

  return violations
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

    // Tolerate ONLY 0% and 100% as stock-phrase percentages
    // (e.g. "100% sure", "0% no-show rate"). Pre-fix this allowlisted
    // any multiple of 25 (25%, 50%, 75%, 100%), which let an LLM
    // fabricate "conversion fell to 25%" through the guard when the
    // truth might have been 18%. Real quantitative percentages must
    // come from classical.numbers. T3 review P1 #7.
    if (tolerateRoundPercents && (token === '0%' || token === '100%')) {
      continue
    }

    // Allowlist check.
    const variants = normaliseNumericToken(token)
    const matched = variants.some((v) => allowed.has(v))
    if (!matched) {
      violations.push({ token, index: idx, kind: 'invented_number' })
    }
  }

  // Layer 2: invented confidence/certainty framing. Catches LLM tics
  // like "I'm 87% confident this will book" + "definitely will book"
  // even when the bare numeric tokens trace to classical.numbers.
  // Hedged language ("likely", "tends to", "may") passes through.
  // T5-followup-X (2026-05-02).
  for (const v of checkConfidenceClaims(narration, opts)) {
    violations.push(v)
  }

  return violations
}
