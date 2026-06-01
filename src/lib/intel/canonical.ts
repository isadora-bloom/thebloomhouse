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
