/**
 * Heat scoring (Phase D-1).
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §7 ("Signal Hierarchy"). The
 * heat score for a couple is the time-decayed weighted sum of its
 * touchpoints. Per doctrine §7 Don't skip #1, aggregate_only signals
 * are excluded. Half-life is 14 days.
 *
 * formula:
 *   heat = sum over touchpoints { weight[tier] * 0.5^(age_days/14) }
 *
 * Weights from doctrine §7:
 *   highest      100  (contract signed, tour attended, calendly booked)
 *   high          60  (message sent any channel, inquiry, email reply)
 *   medium_high   30  (save, calculator, portal access)
 *   medium        15  (click, email-with-click)
 *   low            5  (single view, follow)
 *   aggregate_only 0  (excluded)
 *
 * Susan sees the score as a temperature gradient (cool blue → hot
 * orange → on-fire red), never the number itself.
 */

const WEIGHTS: Record<string, number> = {
  highest: 100,
  high: 60,
  medium_high: 30,
  medium: 15,
  low: 5,
  aggregate_only: 0,
}

const HALF_LIFE_DAYS = 14

export interface HeatTouchpoint {
  signal_tier: string
  occurred_at: string
}

/** One touchpoint's contribution to the heat score — the evidence behind
 *  the number. Used by ghost-risk + any "why is this couple hot/cold"
 *  surface (battery Q19: prediction WITH transparency). */
export interface HeatContribution {
  signalTier: string
  occurredAt: string
  ageDays: number
  weight: number
  /** weight × time-decay — the actual points this touchpoint added. */
  weightedValue: number
}

export interface HeatBreakdown {
  score: number
  /** Contributions sorted most-influential-first. Empty when no scoring
   *  touchpoints (aggregate_only / unknown tiers are excluded). */
  contributions: HeatContribution[]
}

/** The heat score AND the per-touchpoint breakdown that produced it. */
export function computeHeatBreakdown(
  touchpoints: HeatTouchpoint[],
  now = Date.now(),
): HeatBreakdown {
  const contributions: HeatContribution[] = []
  let score = 0
  for (const t of touchpoints) {
    if (t.signal_tier === 'aggregate_only') continue
    const w = WEIGHTS[t.signal_tier]
    if (!w) continue
    const ageDays = (now - Date.parse(t.occurred_at)) / 86_400_000
    const weightedValue = w * Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
    score += weightedValue
    contributions.push({
      signalTier: t.signal_tier,
      occurredAt: t.occurred_at,
      ageDays: Math.round(ageDays * 10) / 10,
      weight: w,
      weightedValue: Math.round(weightedValue * 10) / 10,
    })
  }
  contributions.sort((a, b) => b.weightedValue - a.weightedValue)
  return { score, contributions }
}

/** Time-decayed weighted heat score. Single source of truth =
 *  computeHeatBreakdown (so the score and its explanation never drift). */
export function computeHeatScore(
  touchpoints: HeatTouchpoint[],
  now = Date.now(),
): number {
  return computeHeatBreakdown(touchpoints, now).score
}

/**
 * Heat to temperature label. Buckets calibrated against the weight
 * scale: a single recent 'highest' (100) = Hot. A few 'high' touches
 * = Warm. Single 'low' or older = Cool.
 */
export type HeatBucket = 'cool' | 'warm' | 'hot' | 'on_fire'

export function heatBucket(score: number): HeatBucket {
  if (score >= 150) return 'on_fire'
  if (score >= 60) return 'hot'
  if (score >= 15) return 'warm'
  return 'cool'
}

export function heatColor(bucket: HeatBucket): string {
  switch (bucket) {
    case 'cool':
      return 'bg-sky-100 text-sky-700'
    case 'warm':
      return 'bg-amber-100 text-amber-800'
    case 'hot':
      return 'bg-orange-100 text-orange-800'
    case 'on_fire':
      return 'bg-red-100 text-red-800'
  }
}

export function heatLabel(bucket: HeatBucket): string {
  switch (bucket) {
    case 'cool':
      return 'Cool'
    case 'warm':
      return 'Warm'
    case 'hot':
      return 'Hot'
    case 'on_fire':
      return 'On fire'
  }
}
