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

import type { SupabaseClient } from '@supabase/supabase-js'
import type { AttributionResult } from '@/lib/services/attribution/couple-attribution'
import type { CohortIntel } from '@/lib/services/cohort'
import { computeHeatScore } from '@/lib/services/identity/heat-score'

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

/** Spine-only venue overview: couples counted by lifecycle, the latest
 *  touchpoints as a recent-activity feed, and a data-maturity read
 *  (oldest touchpoint + total count). Reads ONLY `couples` + `touchpoints`,
 *  venue-scoped; excludes merged-away couples from the counts (they are
 *  tombstones, not live couples). Injectable core for unit testing. */
export async function loadVenueOverview(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueOverview> {
  const generatedAt = new Date().toISOString()
  if (!venueId) {
    return {
      couples: { total: 0, byLifecycle: { ...ZERO_LIFECYCLE } },
      recentActivity: [],
      dataMaturity: { backfillStatus: 'unknown', oldestTouchpoint: null, n: 0 },
      generatedAt,
    }
  }

  // Couples by lifecycle — one exact head-count per state, in parallel.
  // lifecycle_state is CHECK-constrained to these six, so the sum is the
  // true total of live (non-merged) couples.
  const states = Object.keys(ZERO_LIFECYCLE) as LifecycleState[]
  const counts = await Promise.all(
    states.map(async (st) => {
      const { count } = await supabase
        .from('couples')
        .select('id', { count: 'exact', head: true })
        .eq('venue_id', venueId)
        .eq('lifecycle_state', st)
        .is('merged_into_id', null)
      return count ?? 0
    }),
  )
  const byLifecycle = { ...ZERO_LIFECYCLE }
  states.forEach((st, i) => {
    byLifecycle[st] = counts[i]
  })
  const total = counts.reduce((a, b) => a + b, 0)

  // Recent activity — the latest touchpoints across the venue.
  const { data: recent } = await supabase
    .from('touchpoints')
    .select('id, channel, action_type, occurred_at, raw_payload')
    .eq('venue_id', venueId)
    .order('occurred_at', { ascending: false })
    .limit(12)
  const recentActivity: ActivityItem[] = ((recent ?? []) as RawJourneyTouchpointRow[]).map(
    (t) => ({
      id: t.id,
      kind: `${t.channel}/${t.action_type}`,
      occurredAt: t.occurred_at,
      summary: pickString(t.raw_payload, 'subject') ?? pickString(t.raw_payload, 'body_preview') ?? `${t.channel} ${t.action_type}`,
    }),
  )

  // Data maturity — total touchpoint count + the oldest one.
  const { count: tpCount } = await supabase
    .from('touchpoints')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  const { data: oldest } = await supabase
    .from('touchpoints')
    .select('occurred_at')
    .eq('venue_id', venueId)
    .order('occurred_at', { ascending: true })
    .limit(1)
  const n = tpCount ?? 0
  const oldestTouchpoint = (oldest?.[0] as { occurred_at: string } | undefined)?.occurred_at ?? null

  return {
    couples: { total, byLifecycle },
    recentActivity,
    dataMaturity: { backfillStatus: n === 0 ? 'empty' : 'populated', oldestTouchpoint, n },
    generatedAt,
  }
}

export async function getVenueOverview(venueId: string): Promise<VenueOverview> {
  if (!venueId) {
    return {
      couples: { total: 0, byLifecycle: { ...ZERO_LIFECYCLE } },
      recentActivity: [],
      dataMaturity: { backfillStatus: 'unknown', oldestTouchpoint: null, n: 0 },
      generatedAt: new Date().toISOString(),
    }
  }
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadVenueOverview(createServiceClient(), venueId)
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

/** Build a Distribution from a builder cell value + sample. Honest by
 *  construction: null value → no_data (n=0) or zero_denominator (n>0);
 *  a present value below the builder's sufficiency gate → insufficient_sample. */
function toDistribution(value: number | null, n: number, enoughData: boolean): Distribution {
  if (value === null) return { value: null, n, enoughData: false, reason: n > 0 ? 'zero_denominator' : 'no_data' }
  if (!enoughData) return { value, n, enoughData: false, reason: 'insufficient_sample' }
  return { value, n, enoughData: true }
}

/** Pure mapping from the attribution builder's per-model channel cells to
 *  the canonical SourceAttribution shape. Exported for unit testing without
 *  a database (feed it a hand-built AttributionResult fixture). `cac` is
 *  converted from the builder's cents to dollars to match the field name;
 *  conversion + revenuePerDollar are unitless ratios, passed through. */
export function mapAttributionToCanonical(
  result: AttributionResult,
  model: AttributionModel,
): SourceAttribution {
  const channels: ChannelStat[] = result.channels.map((row) => {
    const cell = row.models[model]
    return {
      channel: row.channel,
      n: cell.distinctCouples,
      conversion: toDistribution(cell.inquiryToBookingRate, cell.distinctCouples, cell.enoughData),
      cac: toDistribution(cell.cacCents === null ? null : cell.cacCents / 100, cell.distinctBooked, cell.enoughData),
      revenuePerDollar: toDistribution(cell.revenuePerDollar, cell.distinctCouples, cell.enoughData),
    }
  })

  let topByVolume: string | null = null
  let maxN = 0
  let topByConversion: string | null = null
  let maxConv = -1
  for (const row of result.channels) {
    const cell = row.models[model]
    if (cell.distinctCouples > maxN) {
      maxN = cell.distinctCouples
      topByVolume = row.channel
    }
    if (cell.enoughData && cell.inquiryToBookingRate !== null && cell.inquiryToBookingRate > maxConv) {
      maxConv = cell.inquiryToBookingRate
      topByConversion = row.channel
    }
  }

  return { model, channels, topByVolume, topByConversion, generatedAt: result.generatedAt }
}

export async function getSourceAttribution(
  venueId: string,
  opts: SourceAttributionOpts = {},
): Promise<SourceAttribution> {
  const model = opts.model ?? 'first_touch'
  if (!venueId) {
    return { model, channels: [], topByVolume: null, topByConversion: null, generatedAt: new Date().toISOString() }
  }
  const { createServiceClient } = await import('@/lib/supabase/service')
  const { buildCoupleAttribution } = await import('@/lib/services/attribution/couple-attribution')
  const result = await buildCoupleAttribution(createServiceClient(), venueId, {
    since: opts.period?.from ?? null,
  })
  return mapAttributionToCanonical(result, model)
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

/** Map the cohort module's rich Distribution (median/p25/p75/n/enoughData)
 *  to the canonical single-value Distribution. The median is the headline
 *  value; honesty flags carry through. median is null only at n=0. */
function distFromCohort(d: {
  n: number
  enoughData: boolean
  median: number | null
}): Distribution {
  if (d.median === null) return { value: null, n: d.n, enoughData: false, reason: 'no_data' }
  if (!d.enoughData) return { value: d.median, n: d.n, enoughData: false, reason: 'insufficient_sample' }
  return { value: d.median, n: d.n, enoughData: true }
}

/** cohort family trend → canonical ThemePattern trend. */
function mapTrend(t: 'rising' | 'steady' | 'declining' | 'insufficient_data'): ThemePattern['trend'] {
  if (t === 'rising') return 'rising'
  if (t === 'declining') return 'falling'
  return 'flat'
}

/** Pure mapping from the cohort builder's CohortIntel to the canonical
 *  CohortFunnel. Exported for unit testing with a hand-built fixture (no DB).
 *  - funnel: stage label + couple count (the furthest-stage funnel).
 *  - responseTime / leadTime: cohort median as the canonical value.
 *  - conversionCurve: response-speed bands with a measurable tour rate
 *    (bands with null rate are dropped — honest, not plotted as 0).
 *  - knee: the band after which tour rate drops most; dropoffAfter is the
 *    rate delta into the next band.
 *  - textPatterns: topic families → theme + total mentions + trend. */
export function mapCohortIntelToFunnel(intel: CohortIntel): CohortFunnel {
  const funnel: FunnelStage[] = intel.funnel.overall.map((s) => ({ stage: s.label, n: s.count }))

  const bands = intel.curve.bands
  const conversionCurve: CurvePoint[] = bands
    .filter((b) => b.touredRate !== null)
    .map((b) => ({ x: b.lowerHours, y: b.touredRate as number }))

  let knee: CohortFunnel['knee'] = null
  const ki = intel.curve.kneeBandIndex
  if (ki !== null && ki >= 0 && ki < bands.length) {
    const here = bands[ki]
    const next = bands[ki + 1]
    const dropoffAfter =
      here.touredRate !== null && next && next.touredRate !== null
        ? Math.round((here.touredRate - next.touredRate) * 1000) / 1000
        : 0
    knee = { responseHours: here.upperHours ?? here.lowerHours, dropoffAfter }
  }

  const textPatterns: ThemePattern[] = intel.textPatterns.families.map((f) => ({
    theme: f.label,
    count: f.monthly.reduce((s, m) => s + m.mentions, 0),
    trend: mapTrend(f.trend),
  }))

  return {
    funnel,
    responseTime: distFromCohort(intel.responseTime.overall),
    leadTime: distFromCohort(intel.leadTime.dist),
    conversionCurve,
    knee,
    textPatterns,
    generatedAt: intel.generatedAt,
  }
}

export async function getCohortFunnel(
  venueId: string,
  opts: CohortFunnelOpts = {},
): Promise<CohortFunnel> {
  // NOTE: opts.segment + opts.operatorAxis are not yet wired into the
  // cohort builder — accepted for forward-compat, ignored in this pass
  // (operatorBreakdown is therefore omitted, matching the contract's
  // "present only when operatorAxis" — it's simply never present yet).
  if (!venueId) {
    return {
      funnel: [],
      responseTime: { ...EMPTY_DISTRIBUTION },
      leadTime: { ...EMPTY_DISTRIBUTION },
      conversionCurve: [],
      knee: null,
      textPatterns: [],
      generatedAt: new Date().toISOString(),
    }
  }
  const { createServiceClient } = await import('@/lib/supabase/service')
  const { buildCohortIntel } = await import('@/lib/services/cohort')
  const intel = await buildCohortIntel(createServiceClient(), venueId, {
    since: opts.period?.from ?? null,
  })
  return mapCohortIntelToFunnel(intel)
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

/** Spine-only read. Pulls the couple identity, its ordered touchpoint
 *  ribbon, progression anchors, the Wave-4 forensic profile (when the
 *  couple is mirror-linked to a wedding), and a same-stage look-alike
 *  cohort — all from `couples` / `touchpoints` / `couple_progression_events`
 *  / `couple_identity_profile`. NEVER reads the legacy stacks
 *  (interactions / attribution_events / candidate_identities / people).
 *
 *  Tenancy: every query is scoped by `venueId`; a coupleId from a foreign
 *  venue returns `couple: null` (honest-empty), never another tenant's row.
 *
 *  Exported (alongside the public `getCoupleJourney`) so it can be unit-
 *  tested with a mock client without standing up a database — the same
 *  dependency-seam pattern the spine writers use. */
export async function loadCoupleJourney(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string,
): Promise<CoupleJourney> {
  const generatedAt = new Date().toISOString()
  const empty: CoupleJourney = {
    couple: null,
    ribbon: [],
    progression: [],
    identityProfile: null,
    lookAlikeCohort: [],
    generatedAt,
  }
  if (!venueId || !coupleId) return empty

  // 1. Couple identity — venue-scoped. Excludes a merged-away couple
  //    (merged_into_id set) so a stale id resolves to honest-empty rather
  //    than a tombstone; callers should follow the pointer upstream.
  const { data: c } = await supabase
    .from('couples')
    .select(
      'id, venue_id, primary_contact_name, lifecycle_state, heat_score, wedding_date, source_wedding_id, merged_into_id',
    )
    .eq('id', coupleId)
    .eq('venue_id', venueId)
    .maybeSingle<RawJourneyCoupleRow>()
  if (!c || c.merged_into_id) return empty

  // 2. Ribbon — full touchpoint stream, chronological. cascade_stage /
  //    cascade_reason live in raw_payload (written by the cascade at
  //    match time); null when the touchpoint predates cascade telemetry.
  const { data: tps } = await supabase
    .from('touchpoints')
    .select('id, channel, action_type, occurred_at, raw_payload')
    .eq('couple_id', coupleId)
    .order('occurred_at', { ascending: true })
    .limit(1000)
  const ribbon: TouchpointRibbon[] = ((tps ?? []) as RawJourneyTouchpointRow[]).map((t) => ({
    id: t.id,
    channel: t.channel,
    actionType: t.action_type,
    occurredAt: t.occurred_at,
    cascadeStage: pickString(t.raw_payload, 'cascade_stage'),
    cascadeReason: pickString(t.raw_payload, 'cascade_reason'),
  }))

  // 3. Progression anchors.
  const { data: progs } = await supabase
    .from('couple_progression_events')
    .select('event_type, occurred_at')
    .eq('couple_id', coupleId)
    .order('occurred_at', { ascending: true })
  const progression: ProgressionEvent[] = ((progs ?? []) as RawJourneyProgressionRow[]).map(
    (p) => ({ eventType: p.event_type, occurredAt: p.occurred_at }),
  )

  // 4. Wave-4 forensic profile (keyed on the legacy wedding id). Best-
  //    effort enrichment — a missing/unreadable profile leaves it null.
  let identityProfile: Record<string, unknown> | null = null
  if (c.source_wedding_id) {
    try {
      const { data: prof } = await supabase
        .from('couple_identity_profile')
        .select('profile')
        .eq('wedding_id', c.source_wedding_id)
        .maybeSingle<{ profile: Record<string, unknown> | null }>()
      identityProfile = prof?.profile ?? null
    } catch {
      // enrichment, not a gate
    }
  }

  // 5. Look-alike cohort — same venue + same lifecycle stage, excluding
  //    self and merged-away couples. When the target has a wedding date we
  //    rank by date proximity (the closest-season peers); otherwise newest
  //    first. Definition is deliberately spine-cheap + explainable, not a
  //    fuzzy similarity model.
  const lookAlikeCohort = await loadLookAlikeCohort(supabase, venueId, c)

  return {
    couple: {
      id: c.id,
      names: c.primary_contact_name ?? null,
      lifecycle: (c.lifecycle_state as LifecycleState) ?? null,
      heatScore: c.heat_score ?? null,
    },
    ribbon,
    progression,
    identityProfile,
    lookAlikeCohort,
    generatedAt,
  }
}

export async function getCoupleJourney(
  venueId: string,
  coupleId: string,
): Promise<CoupleJourney> {
  if (!venueId || !coupleId) {
    return {
      couple: null,
      ribbon: [],
      progression: [],
      identityProfile: null,
      lookAlikeCohort: [],
      generatedAt: new Date().toISOString(),
    }
  }
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadCoupleJourney(createServiceClient(), venueId, coupleId)
}

// — getCoupleJourney internals —————————————————————————————————————————

interface RawJourneyCoupleRow {
  id: string
  venue_id: string
  primary_contact_name: string | null
  lifecycle_state: string
  heat_score: number | null
  wedding_date: string | null
  source_wedding_id: string | null
  merged_into_id: string | null
}
interface RawJourneyTouchpointRow {
  id: string
  channel: string
  action_type: string
  occurred_at: string
  raw_payload: Record<string, unknown> | null
}
interface RawJourneyProgressionRow {
  event_type: string
  occurred_at: string
}

/** Read a string field out of raw_payload; null when absent / non-string. */
function pickString(raw: Record<string, unknown> | null, key: string): string | null {
  if (!raw) return null
  const v = raw[key]
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

const LOOKALIKE_LIMIT = 6
const LOOKALIKE_SCAN = 60

async function loadLookAlikeCohort(
  supabase: SupabaseClient,
  venueId: string,
  c: RawJourneyCoupleRow,
): Promise<CoupleRef[]> {
  const { data } = await supabase
    .from('couples')
    .select('id, primary_contact_name, wedding_date')
    .eq('venue_id', venueId)
    .eq('lifecycle_state', c.lifecycle_state)
    .neq('id', c.id)
    .is('merged_into_id', null)
    .order('created_at', { ascending: false })
    .limit(LOOKALIKE_SCAN)
  const rows = (data ?? []) as Array<{
    id: string
    primary_contact_name: string | null
    wedding_date: string | null
  }>
  const target = c.wedding_date ? Date.parse(c.wedding_date) : NaN
  if (Number.isFinite(target)) {
    rows.sort((a, b) => {
      const da = a.wedding_date ? Math.abs(Date.parse(a.wedding_date) - target) : Infinity
      const db = b.wedding_date ? Math.abs(Date.parse(b.wedding_date) - target) : Infinity
      return da - db
    })
  }
  return rows.slice(0, LOOKALIKE_LIMIT).map((r) => ({ id: r.id, names: r.primary_contact_name ?? null }))
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

/**
 * SPINE-ONLY reader for the operator's daily landing list. Reads only
 * `couples`, `touchpoints`, `tours` — never the legacy stacks. Injectable
 * core (supabase passed in) so the unit test drives it with a pure mock;
 * the public `getDailyList` wraps the service client.
 *
 * Four buckets, every threshold SOURCED (no invented numbers):
 *  - needsReply : couples whose LATEST touchpoint is an inbound,
 *      progression-eligible signal. Inbound channel/action set mirrors
 *      migration 348 §1 (the set that stamps last_progression_at).
 *      Excludes booked/ghost.
 *  - goingCold : resolved/channel_scoped couples whose decay clock is past
 *      GOING_COLD_FRACTION of decay_window_days but NOT yet the full window
 *      (still recoverable — the decay sweep ghosts them at the full window).
 *      Window arithmetic lifted from decayStaleCouples (decay.ts).
 *  - toursThisWeek : tours scheduled in [now, now+7d], not cancelled/no_show,
 *      resolved to a couple via tours.wedding_id -> couples.source_wedding_id
 *      (tours has no couple_id column).
 *  - highIntent : couples at/above the 'hot' heat bar (60, from
 *      heatBucket() in heat-score.ts), top HIGH_INTENT_LIMIT; heat_score
 *      recomputed from touchpoints when the cached column is null.
 *
 * Venue-scoped + excludes merged-away couples (`merged_into_id IS NULL`,
 * the column migration 379 added — consistent with getCoupleJourney /
 * getVenueOverview). Honest-empty on missing venueId.
 */

/** Fraction of decay_window_days after which a still-resolved couple is
 *  "going cold". CHOSEN (the decay doctrine only defines the full-window
 *  ghost threshold); 0.75 surfaces a couple in the last quarter of its
 *  window — early enough to act, late enough to be a real warning. */
const GOING_COLD_FRACTION = 0.75
/** 'hot' heat bar, sourced from heatBucket() (heat-score.ts). */
const HIGH_INTENT_HEAT_BAR = 60
/** Cap on the highIntent list (top-N by heat). */
const HIGH_INTENT_LIMIT = 10

/** Inbound, progression-eligible (channel, action_type) pairs — mirrors
 *  migration 348 §1. A latest touchpoint matching one of these = the
 *  couple is awaiting a venue reply. */
const INBOUND_ACTIONS: Record<string, ReadonlySet<string>> = {
  gmail: new Set(['reply', 'inquiry']),
  calendly: new Set(['tour_booked', 'tour_attended']),
  honeybook: new Set(['contract_signed', 'booking_signed']),
  knot: new Set(['inquiry', 'message', 'inquiry_form']),
  weddingwire: new Set(['inquiry', 'message', 'inquiry_form']),
  zola: new Set(['inquiry', 'message', 'inquiry_form']),
  portal: new Set(['portal_click', 'portal_visit']),
  website: new Set(['inquiry_form_submitted']),
}

function isInboundTouchpoint(channel: string, actionType: string): boolean {
  return INBOUND_ACTIONS[channel]?.has(actionType) ?? false
}

/** Couple display name, primary then partner — mirrors the couples page. */
function coupleNames(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

interface DailyCoupleRow {
  id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  lifecycle_state: string | null
  last_progression_at: string | null
  decay_window_days: number | null
  heat_score: number | null
  source_wedding_id: string | null
}
interface DailyTouchpointRow {
  couple_id: string | null
  channel: string
  action_type: string
  signal_tier: string
  occurred_at: string
}
interface DailyTourRow {
  id: string
  wedding_id: string | null
  scheduled_at: string | null
  outcome: string | null
}

export async function loadDailyList(
  supabase: SupabaseClient,
  venueId: string,
): Promise<DailyList> {
  const generatedAt = new Date().toISOString()
  const empty: DailyList = {
    needsReply: [],
    goingCold: [],
    toursThisWeek: [],
    highIntent: [],
    generatedAt,
  }
  if (!venueId) return empty

  // Couples spine (channel_scoped included so channel-only saves can still
  // go cold / be high-intent). Excludes merged-away couples (mig 379).
  const { data: coupleData, error: coupleErr } = await supabase
    .from('couples')
    .select(
      'id, primary_contact_name, partner_contact_name, lifecycle_state, last_progression_at, decay_window_days, heat_score, source_wedding_id',
    )
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .limit(5000)
  if (coupleErr) throw new Error(`getDailyList: couples ${coupleErr.message}`)
  const couples = (coupleData ?? []) as DailyCoupleRow[]
  const byId = new Map(couples.map((c) => [c.id, c]))
  const byWedding = new Map<string, DailyCoupleRow>()
  for (const c of couples) {
    if (c.source_wedding_id) byWedding.set(c.source_wedding_id, c)
  }

  // Touchpoints (newest first) for needsReply (latest-is-inbound) + heat.
  const coupleIds = couples.map((c) => c.id)
  const tpByCouple = new Map<string, DailyTouchpointRow[]>()
  if (coupleIds.length > 0) {
    const { data: tpData, error: tpErr } = await supabase
      .from('touchpoints')
      .select('couple_id, channel, action_type, signal_tier, occurred_at')
      .eq('venue_id', venueId)
      .order('occurred_at', { ascending: false })
      .limit(20000)
    if (tpErr) throw new Error(`getDailyList: touchpoints ${tpErr.message}`)
    for (const t of (tpData ?? []) as DailyTouchpointRow[]) {
      if (!t.couple_id || !byId.has(t.couple_id)) continue
      const arr = tpByCouple.get(t.couple_id)
      if (arr) arr.push(t)
      else tpByCouple.set(t.couple_id, [t])
    }
  }

  // needsReply: latest touchpoint (desc → [0]) is inbound.
  const needsReply: CoupleRef[] = []
  for (const c of couples) {
    if (c.lifecycle_state === 'booked' || c.lifecycle_state === 'ghost') continue
    const tps = tpByCouple.get(c.id)
    if (!tps || tps.length === 0) continue
    if (isInboundTouchpoint(tps[0].channel, tps[0].action_type)) {
      needsReply.push({ id: c.id, names: coupleNames(c.primary_contact_name, c.partner_contact_name) })
    }
  }

  // goingCold: decay arithmetic from decay.ts, at GOING_COLD_FRACTION of the
  // window and BEFORE the full window.
  const now = Date.now()
  const goingCold: CoupleRef[] = []
  for (const c of couples) {
    if (c.lifecycle_state !== 'resolved' && c.lifecycle_state !== 'channel_scoped') continue
    if (!c.last_progression_at) continue
    const ageMs = now - Date.parse(c.last_progression_at)
    // Canonical v1.0 §3.4: default 120 (migration 380; was 180).
    const windowMs = (c.decay_window_days ?? 120) * 86_400_000
    if (ageMs >= GOING_COLD_FRACTION * windowMs && ageMs < windowMs) {
      goingCold.push({ id: c.id, names: coupleNames(c.primary_contact_name, c.partner_contact_name) })
    }
  }

  // toursThisWeek: [now, now+7d], not cancelled/no_show, resolved to a couple.
  const weekFromNow = new Date(now + 7 * 86_400_000).toISOString()
  const nowIso = new Date(now).toISOString()
  const { data: tourData, error: tourErr } = await supabase
    .from('tours')
    .select('id, wedding_id, scheduled_at, outcome')
    .eq('venue_id', venueId)
    .gte('scheduled_at', nowIso)
    .lte('scheduled_at', weekFromNow)
    .order('scheduled_at', { ascending: true })
    .limit(2000)
  if (tourErr) throw new Error(`getDailyList: tours ${tourErr.message}`)
  const toursThisWeek: TourRef[] = []
  for (const t of (tourData ?? []) as DailyTourRow[]) {
    if (t.outcome === 'cancelled' || t.outcome === 'no_show') continue
    if (!t.scheduled_at || !t.wedding_id) continue
    const couple = byWedding.get(t.wedding_id)
    if (!couple) continue
    toursThisWeek.push({ id: t.id, coupleId: couple.id, scheduledAt: t.scheduled_at })
  }

  // highIntent: heat_score (cached) or recomputed, above the 'hot' bar, top N.
  const scored: Array<{ ref: CoupleRef; heat: number }> = []
  for (const c of couples) {
    if (c.lifecycle_state === 'ghost' || c.lifecycle_state === 'agent') continue
    let heat = typeof c.heat_score === 'number' ? c.heat_score : null
    if (heat === null) {
      const tps = tpByCouple.get(c.id) ?? []
      heat = computeHeatScore(
        tps.map((t) => ({ signal_tier: t.signal_tier, occurred_at: t.occurred_at })),
        now,
      )
    }
    if (heat >= HIGH_INTENT_HEAT_BAR) {
      scored.push({
        ref: { id: c.id, names: coupleNames(c.primary_contact_name, c.partner_contact_name) },
        heat,
      })
    }
  }
  scored.sort((a, b) => b.heat - a.heat)
  const highIntent = scored.slice(0, HIGH_INTENT_LIMIT).map((s) => s.ref)

  return { needsReply, goingCold, toursThisWeek, highIntent, generatedAt }
}

export async function getDailyList(venueId: string): Promise<DailyList> {
  if (!venueId) {
    return {
      needsReply: [],
      goingCold: [],
      toursThisWeek: [],
      highIntent: [],
      generatedAt: new Date().toISOString(),
    }
  }
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadDailyList(createServiceClient(), venueId)
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

/** Nil UUID used as the actor when a canonical askIntel call has no user
 *  context. The NLQ brain logs each query to natural_language_queries with
 *  this user_id; the log insert is best-effort (non-fatal on failure), so a
 *  sentinel actor never blocks the answer. */
const ASK_INTEL_SYSTEM_USER = '00000000-0000-0000-0000-000000000000'

/** Pure mapping from the NLQ brain's result to the canonical IntelAnswer.
 *  Exported for unit testing without the LLM. The brain answers
 *  conversationally with inline citations (no structured evidence refs), so
 *  `evidence` is []; confidence is derived from the post-call honesty
 *  inspector — any tripped honesty flag means the answer hedged. */
export function mapNLQToAnswer(nlq: { response: string; honestyFlags: readonly unknown[] }): IntelAnswer {
  return {
    answer: nlq.response,
    evidence: [],
    confidence: (nlq.honestyFlags?.length ?? 0) > 0 ? 'hedged' : 'high',
    generatedAt: new Date().toISOString(),
  }
}

export async function askIntel(venueId: string, question: string): Promise<IntelAnswer> {
  if (!venueId || !question.trim()) {
    return {
      answer: 'Ask a question about this venue’s performance, bookings, sources, or trends.',
      evidence: [],
      confidence: 'refused',
      generatedAt: new Date().toISOString(),
    }
  }
  const { answerNaturalLanguageQuery } = await import('@/lib/services/brain/intel-brain')
  const nlq = await answerNaturalLanguageQuery(venueId, ASK_INTEL_SYSTEM_USER, question)
  return mapNLQToAnswer(nlq)
}
