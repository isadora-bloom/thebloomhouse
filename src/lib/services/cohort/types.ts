/**
 * D9 — couple-keyed cohort intelligence. Shared types.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md Appendix C (§C.4 battery
 * matrix, §C.5 T8.2). D9 migrates the venue intelligence layer onto the
 * identity-first spine: every cohort metric is keyed on `couples` +
 * `touchpoints`, never on the legacy `weddings` / `inquiries` rows.
 *
 * Doctrine note (honesty — Appendix C §C.6, Tier 4 of the battery):
 * every distribution carries its own `n`. A surface that renders a
 * median must also render the n it was computed from, and the
 * data-maturity gate (MIN_DISTRIBUTION_N) decides whether the median is
 * shown at all. A confident number over n=2 is a Tier-4 failure.
 */

/** lifecycle_state values that represent a couple the venue engaged
 *  with. `channel_scoped` (un-acknowledged prospect / often vendor
 *  noise) and `agent` are excluded from funnel ratios. */
// 2026-05-20: 'completed' added as a post-wedding terminal-positive
// state distinct from 'booked' (pre-wedding signed contract). Both
// count as engaged for funnel ratios + cohort metrics.
export const ENGAGED_STATES = ['resolved', 'booked', 'ghost', 'completed'] as const
export type EngagedState = (typeof ENGAGED_STATES)[number]

/** A median / distribution is only surfaced at or above this n.
 *  Below it the surface shows the raw n and "not enough data yet". */
export const MIN_DISTRIBUTION_N = 8

// ---------------------------------------------------------------------------
// Raw spine rows (the subset of columns D9 reads)
// ---------------------------------------------------------------------------

export interface CoupleRow {
  id: string
  lifecycle_state: string
  channel_scope: string | null
  wedding_date: string | null
  heat_score: number | null
  created_at: string
  primary_contact_name: string
}

export interface TouchpointRow {
  id: string
  couple_id: string | null
  channel: string
  action_type: string
  occurred_at: string
  signal_tier: string
  confidence_tier: string | null
  raw_payload: Record<string, unknown> | null
}

export interface ProgressionRow {
  couple_id: string
  occurred_at: string
  event_type: string
}

export interface CohortData {
  venueId: string
  timezone: string
  couples: CoupleRow[]
  touchpoints: TouchpointRow[]
  progression: ProgressionRow[]
  /** touchpoints grouped by couple_id, each list sorted occurred_at ASC. */
  byCouple: Map<string, TouchpointRow[]>
}

// ---------------------------------------------------------------------------
// Distribution primitive
// ---------------------------------------------------------------------------

/** A computed distribution. `enoughData` is false below
 *  MIN_DISTRIBUTION_N — surfaces must check it before rendering a
 *  median as fact. */
export interface Distribution {
  n: number
  enoughData: boolean
  min: number | null
  p25: number | null
  median: number | null
  p75: number | null
  p90: number | null
  max: number | null
  mean: number | null
}

// ---------------------------------------------------------------------------
// Funnel (Q7 / Q8 / Q14)
// ---------------------------------------------------------------------------

export interface FunnelStage {
  key: 'inquiry' | 'replied' | 'tour_booked' | 'toured' | 'booked'
  label: string
  count: number
  /** Conversion from the previous stage, 0-1. null for the first stage. */
  fromPrevious: number | null
  /** Conversion from the inquiry stage, 0-1. */
  fromInquiry: number | null
}

export interface FunnelSegment {
  label: string
  inquiries: number
  toured: number
  booked: number
  inquiryToTour: number | null
  tourToBooked: number | null
  inquiryToBooked: number | null
}

export interface FunnelResult {
  overall: FunnelStage[]
  /** channel-scoped prospects sit outside the funnel ratios (doctrine:
   *  un-acknowledged, often vendor noise) — surfaced as a count only. */
  channelScopedCount: number
  ghostCount: number
  /** Engaged couples whose only signal is the mirror-couple back-fill —
   *  i.e. they have ZERO touchpoints attached. These still count in the
   *  inquiry stage (the venue acknowledged them) but they drag every
   *  downstream ratio toward zero because there is nothing in the spine
   *  yet to evaluate. Surfaced so the funnel can be read honestly. */
  couplesWithoutTouchpoints: number
  bySeason: FunnelSegment[]
  byTourWeekday: FunnelSegment[]
  byHolidayWindow: FunnelSegment[]
}

// ---------------------------------------------------------------------------
// Response time (Q1 / Q2 / Q4 / Q22)
// ---------------------------------------------------------------------------

/** A response-time observation: hours between a couple's first inbound
 *  touchpoint and the venue's first reply to it. */
export interface ResponseTimeResult {
  /** All couples with a measurable first-reply time. */
  overall: Distribution
  /** 12-month delta: median over the last 365d vs the prior 365d. */
  last12moMedian: number | null
  prior12moMedian: number | null
  deltaHours: number | null
  /** couples whose first inbound never got a venue reply. */
  neverRepliedCount: number
  byOutcome: { outcome: 'booked' | 'ghost' | 'in_progress'; dist: Distribution }[]
  byChannel: { channel: string; dist: Distribution }[]
  byArrivalHour: { hour: number; dist: Distribution }[]
}

// ---------------------------------------------------------------------------
// Lead time (Q11)
// ---------------------------------------------------------------------------

export interface LeadTimeResult {
  /** days between first touchpoint and wedding_date. */
  dist: Distribution
  /** histogram buckets in months-to-wedding. */
  histogram: { bucket: string; count: number }[]
  couplesWithDate: number
  couplesWithoutDate: number
}

// ---------------------------------------------------------------------------
// Response-time -> tour conversion curve (Q3 / Q25)
// ---------------------------------------------------------------------------

export interface CurveBand {
  label: string
  lowerHours: number
  upperHours: number | null
  couples: number
  touredRate: number | null
}

export interface CurveResult {
  bands: CurveBand[]
  /** the band index after which tour-rate drops most — the "knee". */
  kneeBandIndex: number | null
  kneeNote: string
  /** pre-tour signal counts: how often each signal precedes a booking
   *  vs a ghost (Q25). */
  preTourSignals: {
    signal: string
    beforeBooking: number
    beforeGhost: number
    lift: number | null
  }[]
}

// ---------------------------------------------------------------------------
// Text patterns (Q13 / Q15 / Q27)
// ---------------------------------------------------------------------------

export interface PatternSeries {
  family: string
  label: string
  /** monthly counts of inbound touchpoints mentioning the family. */
  monthly: { month: string; mentions: number; inboundTotal: number }[]
  trend: 'rising' | 'steady' | 'declining' | 'insufficient_data'
}

export interface TextPatternResult {
  families: PatternSeries[]
  /** first-message language: median length + question count over time. */
  firstMessage: {
    monthly: { month: string; n: number; medianWords: number | null; medianQuestions: number | null }[]
    note: string
  }
}

// ---------------------------------------------------------------------------
// YoY (Q12)
// ---------------------------------------------------------------------------

export interface YoYResult {
  thisYearLabel: number
  lastYearLabel: number
  monthly: {
    month: number // 1-12
    label: string
    thisYear: number
    lastYear: number
    deltaPct: number | null
    /** Marketing spend in the same month, cents. null when no spend
     *  data — lets the surface show YoY "controlling for marketing"
     *  only where the confound is actually measurable (Q12). */
    thisYearSpendCents: number | null
    lastYearSpendCents: number | null
  }[]
  marketingSpendAvailable: boolean
  marketingNote: string
}

// ---------------------------------------------------------------------------
// Weather x tour no-show (Q10)
// ---------------------------------------------------------------------------

export interface WeatherResult {
  available: boolean
  note: string
  badWeatherTours: number
  badWeatherNoShows: number
  fairWeatherTours: number
  fairWeatherNoShows: number
  badWeatherNoShowRate: number | null
  fairWeatherNoShowRate: number | null
}

// ---------------------------------------------------------------------------
// Anomaly
// ---------------------------------------------------------------------------

export interface CohortAnomaly {
  metric: string
  month: string
  observed: number
  expected: number
  severity: 'low' | 'medium' | 'high'
  note: string
}

// ---------------------------------------------------------------------------
// Top-level payload
// ---------------------------------------------------------------------------

export interface CohortIntel {
  venueId: string
  generatedAt: string
  timezone: string
  meta: {
    coupleCount: number
    engagedCoupleCount: number
    touchpointCount: number
    earliestTouchpoint: string | null
    latestTouchpoint: string | null
  }
  funnel: FunnelResult
  responseTime: ResponseTimeResult
  leadTime: LeadTimeResult
  curve: CurveResult
  textPatterns: TextPatternResult
  yoy: YoYResult
  weather: WeatherResult
  anomalies: CohortAnomaly[]
}
