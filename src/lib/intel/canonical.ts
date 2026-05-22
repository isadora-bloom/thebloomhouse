/**
 * Intel Canonical API — the six read functions.
 *
 * Day 4-5 stub of CONSOLIDATION-PLAN-25-DAY-ANCHORED.md, per the
 * contract in INTEL-CANONICAL-API.md.
 *
 * STATUS: STUB. The signatures + types below are LIVE — surfaces and
 * contract tests may be written against them now. The implementations
 * return honest-empty data (n:0, enoughData:false, null values, empty
 * arrays) and are filled in Days 14-16:
 *
 *   getSourceAttribution ← wraps buildCoupleAttribution (D3, couple-attribution.ts)
 *   getVenueOverview     ← folds buildSourceQualityReport (D8, cohort/source-quality.ts)
 *   getCohortFunnel      ← wraps loadCohortData (cohort/data.ts)
 *   getCoupleJourney     ← consolidates journey-ribbon logic
 *   getDailyList         ← new (Day 20-22 landing substrate)
 *   askIntel             ← wraps the NLQ brain (brain/intel-brain.ts)
 *
 * Doctrine: the number six does NOT grow. A new surface need becomes a
 * parameter on one of these, never a seventh function. Every metric
 * carries `n` + `enoughData`; every ratio is `null` (never fake-0) on a
 * zero denominator.
 */

// ─────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────

/** couples.lifecycle_state — migration 346 (5 values) + 365 ('completed'). */
export type LifecycleState =
  | 'channel_scoped'
  | 'resolved'
  | 'booked'
  | 'completed'
  | 'ghost'
  | 'agent'

export interface DateRange {
  from: string
  to: string
}

/**
 * The honesty primitive. Every metric the API returns carries its own
 * sample size + sufficiency. `value` is `null` — never a fake 0 — when
 * there is no data or a zero denominator.
 */
export interface Distribution {
  value: number | null
  n: number
  enoughData: boolean
  reason?: 'insufficient_sample' | 'no_data' | 'zero_denominator'
}

export type AttributionModel = 'first_touch' | 'last_touch' | 'linear' | 'time_decay'

/** Opaque segment selector — 'channel:knot' | 'season:spring_2026' | ... */
export type SegmentKey = string

export interface CoupleRef {
  id: string
  names: string | null
}

// ─────────────────────────────────────────────────────────────────────
// 1. getVenueOverview
// ─────────────────────────────────────────────────────────────────────

export interface ActivityItem {
  id: string
  kind: string
  occurredAt: string
  summary: string
}

export interface VenueOverview {
  couples: {
    total: number
    byLifecycle: Record<LifecycleState, number>
  }
  recentActivity: ActivityItem[]
  dataMaturity: {
    backfillStatus: string
    oldestTouchpoint: string | null
    n: number
  }
  generatedAt: string
}

const ZERO_LIFECYCLE: Record<LifecycleState, number> = {
  channel_scoped: 0,
  resolved: 0,
  booked: 0,
  completed: 0,
  ghost: 0,
  agent: 0,
}

export async function getVenueOverview(venueId: string): Promise<VenueOverview> {
  void venueId // STUB — implemented Day 14
  return {
    couples: { total: 0, byLifecycle: { ...ZERO_LIFECYCLE } },
    recentActivity: [],
    dataMaturity: { backfillStatus: 'unknown', oldestTouchpoint: null, n: 0 },
    generatedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. getSourceAttribution
// ─────────────────────────────────────────────────────────────────────

export interface ChannelStat {
  channel: string
  n: number
  conversion: Distribution
  cac: Distribution
  revenuePerDollar: Distribution
}

export interface SourceAttribution {
  model: AttributionModel
  channels: ChannelStat[]
  topByVolume: string | null
  topByConversion: string | null
  generatedAt: string
}

export interface SourceAttributionOpts {
  model?: AttributionModel
  period?: DateRange
}

export async function getSourceAttribution(
  venueId: string,
  opts: SourceAttributionOpts = {},
): Promise<SourceAttribution> {
  void venueId // STUB — implemented Day 14 (wraps buildCoupleAttribution)
  return {
    model: opts.model ?? 'first_touch',
    channels: [],
    topByVolume: null,
    topByConversion: null,
    generatedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 3. getCohortFunnel
// ─────────────────────────────────────────────────────────────────────

export interface FunnelStage {
  stage: string
  n: number
}

export interface CurvePoint {
  x: number
  y: number
}

export interface ThemePattern {
  theme: string
  count: number
  trend: 'rising' | 'flat' | 'falling'
}

export interface OperatorStat {
  operator: string
  responseTime: Distribution
  stalledCount: number
}

export interface CohortFunnel {
  funnel: FunnelStage[]
  responseTime: Distribution
  leadTime: Distribution
  conversionCurve: CurvePoint[]
  /** § M — detectKnee(); null when no inflection point is detectable. */
  knee: { responseHours: number; dropoffAfter: number } | null
  textPatterns: ThemePattern[]
  /** Present only when opts.operatorAxis === true (§ M, battery Tier 5). */
  operatorBreakdown?: OperatorStat[]
  generatedAt: string
}

export interface CohortFunnelOpts {
  period?: DateRange
  segment?: SegmentKey
  operatorAxis?: boolean
}

const EMPTY_DISTRIBUTION: Distribution = {
  value: null,
  n: 0,
  enoughData: false,
  reason: 'no_data',
}

export async function getCohortFunnel(
  venueId: string,
  opts: CohortFunnelOpts = {},
): Promise<CohortFunnel> {
  void venueId // STUB — implemented Day 15 (wraps loadCohortData)
  return {
    funnel: [],
    responseTime: { ...EMPTY_DISTRIBUTION },
    leadTime: { ...EMPTY_DISTRIBUTION },
    conversionCurve: [],
    knee: null,
    textPatterns: [],
    ...(opts.operatorAxis ? { operatorBreakdown: [] } : {}),
    generatedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 4. getCoupleJourney
// ─────────────────────────────────────────────────────────────────────

export interface CoupleIdentity {
  id: string
  names: string | null
  lifecycle: LifecycleState | null
  heatScore: number | null
}

export interface TouchpointRibbon {
  id: string
  channel: string
  actionType: string
  occurredAt: string
  cascadeStage: string | null
  cascadeReason: string | null
}

export interface ProgressionEvent {
  eventType: string
  occurredAt: string
}

export interface CoupleJourney {
  couple: CoupleIdentity | null
  ribbon: TouchpointRibbon[]
  progression: ProgressionEvent[]
  identityProfile: Record<string, unknown> | null
  lookAlikeCohort: CoupleRef[]
  generatedAt: string
}

export async function getCoupleJourney(
  venueId: string,
  coupleId: string,
): Promise<CoupleJourney> {
  void venueId // STUB — implemented Day 15
  void coupleId
  return {
    couple: null,
    ribbon: [],
    progression: [],
    identityProfile: null,
    lookAlikeCohort: [],
    generatedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 5. getDailyList
// ─────────────────────────────────────────────────────────────────────

export interface TourRef {
  id: string
  coupleId: string
  scheduledAt: string
}

export interface DailyList {
  needsReply: CoupleRef[]
  goingCold: CoupleRef[]
  toursThisWeek: TourRef[]
  highIntent: CoupleRef[]
  generatedAt: string
}

export async function getDailyList(venueId: string): Promise<DailyList> {
  void venueId // STUB — implemented Day 16
  return {
    needsReply: [],
    goingCold: [],
    toursThisWeek: [],
    highIntent: [],
    generatedAt: new Date().toISOString(),
  }
}

// ─────────────────────────────────────────────────────────────────────
// 6. askIntel
// ─────────────────────────────────────────────────────────────────────

export interface EvidenceRef {
  kind: 'quote' | 'row' | 'metric'
  ref: string
  quote?: string
}

export interface IntelAnswer {
  answer: string
  evidence: EvidenceRef[]
  confidence: 'high' | 'hedged' | 'refused'
  generatedAt: string
}

export async function askIntel(venueId: string, question: string): Promise<IntelAnswer> {
  void venueId // STUB — implemented Day 16 (wraps the NLQ brain)
  return {
    answer:
      'Intel is not yet implemented (canonical API stub). ' +
      `Question received: ${question.slice(0, 120)}`,
    evidence: [],
    confidence: 'refused',
    generatedAt: new Date().toISOString(),
  }
}
