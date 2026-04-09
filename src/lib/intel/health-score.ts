/**
 * Composite venue health score.
 *
 * Each input metric is explicitly nullable. If null, it does NOT contribute
 * to the average (metric is unknown, not poor). If 0, it DOES contribute as 0.
 * When every input is null we return null so the UI can render "No data"
 * instead of pretending a perfect score exists.
 *
 * Scaling:
 * - bookingConversionRate (0..1): 30% conversion = 100
 * - responseTimeMinutes:          30 min = 100, 240 min = 0
 * - avgReviewRating (0..5):       5 = 100, 4.5 = 90
 * - sourceCount (diversity):      1 source = 50, 5+ sources = 100
 * - bookingPace (0..1):           ratio of bookings vs target
 */

export interface HealthScoreInputs {
  bookingConversionRate?: number | null
  responseTimeMinutes?: number | null
  avgReviewRating?: number | null
  sourceCount?: number | null
  bookingPace?: number | null
}

export interface HealthScoreBreakdown {
  overall: number | null
  dataQuality: number | null
  pipelineHealth: number | null
  responseTime: number | null
  bookingRate: number | null
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, n))
}

export function computeHealthScore(metrics: HealthScoreInputs): number | null {
  const scores: number[] = []

  if (metrics.bookingConversionRate != null && !Number.isNaN(metrics.bookingConversionRate)) {
    scores.push(clamp((metrics.bookingConversionRate / 0.3) * 100))
  }
  if (metrics.responseTimeMinutes != null && !Number.isNaN(metrics.responseTimeMinutes)) {
    scores.push(clamp(100 - ((metrics.responseTimeMinutes - 30) / 210) * 100))
  }
  if (metrics.avgReviewRating != null && !Number.isNaN(metrics.avgReviewRating)) {
    scores.push(clamp((metrics.avgReviewRating / 5) * 100))
  }
  if (metrics.sourceCount != null && !Number.isNaN(metrics.sourceCount)) {
    scores.push(clamp(50 + (metrics.sourceCount - 1) * 12.5))
  }
  if (metrics.bookingPace != null && !Number.isNaN(metrics.bookingPace)) {
    scores.push(clamp(metrics.bookingPace * 100))
  }

  if (scores.length === 0) return null
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
}

/**
 * Four-dimension breakdown used by the Health Dashboard. Each sub-dimension
 * is itself nullable; averaging only includes present ones.
 */
export function computeHealthBreakdown(args: {
  bookingConversionRate?: number | null
  responseTimeMinutes?: number | null
  sourceCount?: number | null
  bookingPace?: number | null
  // Pipeline: fraction of weddings in active stages (not lost / not stale)
  pipelineActiveRatio?: number | null
  // Data quality: fraction of key fields filled across records (0..1)
  dataCompleteness?: number | null
  avgReviewRating?: number | null
}): HealthScoreBreakdown {
  const dataQuality =
    args.dataCompleteness != null && !Number.isNaN(args.dataCompleteness)
      ? clamp(args.dataCompleteness * 100)
      : null

  const pipelineHealth =
    args.pipelineActiveRatio != null && !Number.isNaN(args.pipelineActiveRatio)
      ? clamp(args.pipelineActiveRatio * 100)
      : null

  const responseTime =
    args.responseTimeMinutes != null && !Number.isNaN(args.responseTimeMinutes)
      ? clamp(100 - ((args.responseTimeMinutes - 30) / 210) * 100)
      : null

  const bookingRate =
    args.bookingConversionRate != null && !Number.isNaN(args.bookingConversionRate)
      ? clamp((args.bookingConversionRate / 0.3) * 100)
      : null

  const overall = computeHealthScore({
    bookingConversionRate: args.bookingConversionRate,
    responseTimeMinutes: args.responseTimeMinutes,
    avgReviewRating: args.avgReviewRating,
    sourceCount: args.sourceCount,
    bookingPace: args.bookingPace,
  })

  return {
    overall,
    dataQuality: dataQuality != null ? Math.round(dataQuality) : null,
    pipelineHealth: pipelineHealth != null ? Math.round(pipelineHealth) : null,
    responseTime: responseTime != null ? Math.round(responseTime) : null,
    bookingRate: bookingRate != null ? Math.round(bookingRate) : null,
  }
}
