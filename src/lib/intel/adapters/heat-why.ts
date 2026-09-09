/**
 * Heat, with the working shown.
 *
 * `computeHeatBreakdown` (services/identity/heat-score.ts) already
 * returns the per-touchpoint contributions behind a heat score. Nothing
 * rendered it: the operator surfaces showed a badge and a number, so a
 * coordinator asking "why is this couple hot" had nowhere to look. That
 * is battery Q19 — prediction WITH transparency, not prediction alone.
 *
 * This adapter turns the breakdown into short operator sentences that
 * the shared WhyThisCard can render. It invents nothing: every line is a
 * touchpoint that actually contributed, in the order it contributed.
 *
 * Pure. Unit-tested in ./__tests__/heat-why.test.ts.
 */

import {
  computeHeatBreakdown,
  heatBucket,
  heatLabel,
  type HeatTouchpoint,
} from '@/lib/services/identity/heat-score'

export interface HeatWhy {
  score: number
  /** Rounded for display. The raw score is a decimal sum. */
  displayScore: number
  bucket: ReturnType<typeof heatBucket>
  label: string
  /** One line per contributing touchpoint, most influential first. */
  evidence: string[]
  /** The sentence that explains the score as a whole. */
  reasoning: string
  /** How many touchpoints actually scored. Zero-tier signals are
   *  excluded by the scorer, so this can be lower than the ribbon length. */
  contributingCount: number
}

/** Cap on rendered evidence lines. Beyond this the tail is decayed to
 *  near-nothing anyway, and a coordinator stops reading. */
const MAX_EVIDENCE_LINES = 6

const TIER_PHRASE: Record<string, string> = {
  highest: 'a top-tier signal',
  high: 'a strong signal',
  medium_high: 'a mid-tier signal',
  medium: 'a light signal',
  low: 'a weak signal',
}

function agePhrase(ageDays: number): string {
  if (ageDays < 1) return 'today'
  if (ageDays < 2) return 'yesterday'
  if (ageDays < 14) return `${Math.round(ageDays)} days ago`
  if (ageDays < 60) return `${Math.round(ageDays / 7)} weeks ago`
  return `${Math.round(ageDays / 30)} months ago`
}

/**
 * Build the operator-facing explanation of a heat score from the same
 * touchpoints the scorer saw.
 *
 * Pass the couple's touchpoints (signal_tier + occurred_at is all the
 * scorer needs). `now` is injectable so tests are not clock-dependent.
 */
export function buildHeatWhy(
  touchpoints: readonly HeatTouchpoint[],
  now = Date.now(),
): HeatWhy {
  const breakdown = computeHeatBreakdown([...touchpoints], now)
  const bucket = heatBucket(breakdown.score)
  const displayScore = Math.round(breakdown.score)

  const evidence = breakdown.contributions
    .slice(0, MAX_EVIDENCE_LINES)
    .map((c) => {
      const phrase = TIER_PHRASE[c.signalTier] ?? 'a signal'
      return `${phrase} ${agePhrase(c.ageDays)} added ${c.weightedValue} of ${c.weight}`
    })

  let reasoning: string
  if (breakdown.contributions.length === 0) {
    reasoning =
      'No scoring touchpoints yet. Heat is a decayed sum of real signals, so with nothing to sum it stays at zero rather than guessing.'
  } else {
    const top = breakdown.contributions[0]
    reasoning =
      `Heat is the time-decayed sum of every signal from this couple, on a 14-day half-life. ` +
      `${breakdown.contributions.length} signal${breakdown.contributions.length === 1 ? '' : 's'} scored; ` +
      `the biggest was ${TIER_PHRASE[top.signalTier] ?? 'a signal'} ${agePhrase(top.ageDays)}. ` +
      `A signal loses half its weight every fortnight, which is why an old contract signing counts for less than a reply this week.`
  }

  return {
    score: breakdown.score,
    displayScore,
    bucket,
    label: heatLabel(bucket),
    evidence,
    reasoning,
    contributingCount: breakdown.contributions.length,
  }
}
