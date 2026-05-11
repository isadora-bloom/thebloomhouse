/**
 * Bloom House — Wave 24 airtightness rules.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (measure don't assume; never cite
 *     a number without sample-size annotation)
 *   - feedback_deep_fix_vs_bandaid.md (the rules layer is shared across
 *     every answer, not re-implemented per question — band-aid resistance)
 *   - PROMPT-BIAS-AUDIT.md (v1-contaminated rows surface an asterisk)
 *
 * Three rules every Channel Truth answer obeys:
 *   1. Sample-size pill: high (n>=30) / moderate (10<=n<30) / thin (n<10).
 *   2. v1-contamination disclosure: any row with
 *      attribution_events.prompt_version_classified_under matching the
 *      Wave 21 critical findings flags the cell.
 *   3. Data freshness: max(intent_classified_at) over the underlying
 *      rows; >24h triggers a freshness warning on the page calibration
 *      pill.
 *
 * These helpers are PURE — no DB calls, no LLM calls. Compute functions
 * call them after assembling cells.
 */

import type { ComputedCell, ConfidenceLevel } from './types'

/** The Wave 21-flagged v1 prompts (critical bias findings). */
export const V1_CONTAMINATED_PROMPT_VERSIONS: ReadonlySet<string> = new Set([
  'channel-role-classifier.prompt.v1',
  'inquiry-intent-judge.prompt.v1',
])

/**
 * Given a list of prompt_version strings (one per underlying row),
 * return the pct that match the v1-critical set.
 */
export function computeV1ContaminationPct(
  promptVersions: (string | null)[],
): number {
  const total = promptVersions.length
  if (total === 0) return 0
  let contaminated = 0
  for (const pv of promptVersions) {
    if (pv && V1_CONTAMINATED_PROMPT_VERSIONS.has(pv)) {
      contaminated += 1
    }
  }
  return (contaminated / total) * 100
}

/** Returns true iff the prompt version is on the v1-critical list. */
export function isV1Contaminated(pv: string | null | undefined): boolean {
  return !!pv && V1_CONTAMINATED_PROMPT_VERSIONS.has(pv)
}

/**
 * Derive the confidence-level pill. Take the SMALLEST cell sample size
 * (worst case across what the narration depends on).
 *   n >= 30 → high
 *   10 <= n < 30 → moderate
 *   n < 10 → thin
 */
export function deriveConfidenceLevel(cells: ComputedCell[]): ConfidenceLevel {
  if (cells.length === 0) return 'thin'
  let smallest = Infinity
  for (const c of cells) {
    if (c.n < smallest) smallest = c.n
  }
  if (smallest >= 30) return 'high'
  if (smallest >= 10) return 'moderate'
  return 'thin'
}

/**
 * Wilson 95% CI half-width for a proportion. Standard formula:
 *   half = z * sqrt(p*(1-p)/n) / (1 + z^2/n)
 * with z=1.96. Returns null when n=0.
 */
export function wilsonHalfWidth(p: number, n: number): number | null {
  if (n <= 0) return null
  if (p < 0 || p > 1) return null
  const z = 1.96
  const denom = 1 + (z * z) / n
  const numerator = z * Math.sqrt((p * (1 - p)) / n)
  return numerator / denom
}

/**
 * Helper to assemble a cell with proportion semantics (booked / sample).
 */
export function makeProportionCell(args: {
  label: string
  numerator: number
  denominator: number
  promptVersions: (string | null)[]
  contributingWeddingIds: string[]
}): ComputedCell {
  const { label, numerator, denominator, promptVersions, contributingWeddingIds } = args
  const p = denominator > 0 ? numerator / denominator : 0
  const ci = wilsonHalfWidth(p, denominator)
  return {
    label,
    n: denominator,
    headline_value: denominator > 0 ? p : null,
    ci_95_half_width: ci,
    v1_contaminated_pct: computeV1ContaminationPct(promptVersions),
    contributing_wedding_ids: contributingWeddingIds.slice(0, 50),
  }
}

/**
 * Helper to assemble a cell with raw-count semantics (no rate).
 */
export function makeCountCell(args: {
  label: string
  count: number
  promptVersions: (string | null)[]
  contributingWeddingIds: string[]
}): ComputedCell {
  return {
    label: args.label,
    n: args.count,
    headline_value: args.count,
    ci_95_half_width: null,
    v1_contaminated_pct: computeV1ContaminationPct(args.promptVersions),
    contributing_wedding_ids: args.contributingWeddingIds.slice(0, 50),
  }
}

/** Helper for "free-form" cells with a non-numeric headline. */
export function makeFreeformCell(args: {
  label: string
  n: number
  headline_value: unknown
  promptVersions: (string | null)[]
  contributingWeddingIds: string[]
}): ComputedCell {
  return {
    label: args.label,
    n: args.n,
    headline_value: args.headline_value,
    ci_95_half_width: null,
    v1_contaminated_pct: computeV1ContaminationPct(args.promptVersions),
    contributing_wedding_ids: args.contributingWeddingIds.slice(0, 50),
  }
}

/**
 * Cross-cell aggregate: weighted average v1-contamination pct.
 * Used for the answer-level disclosure.
 */
export function aggregateContaminationPct(cells: ComputedCell[]): number {
  let weightedSum = 0
  let totalN = 0
  for (const c of cells) {
    weightedSum += c.v1_contaminated_pct * c.n
    totalN += c.n
  }
  if (totalN === 0) return 0
  return weightedSum / totalN
}
