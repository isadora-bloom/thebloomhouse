/**
 * Bloom House — Wave 25 channel snapshot computer.
 *
 * Anchor docs:
 *   - feedback_measure_dont_assume.md (snapshot is a DENORMALISED
 *     measurement; we never invent or estimate beyond the underlying
 *     attribution_events / weddings / reviews / spend rows)
 *   - feedback_deep_fix_vs_bandaid.md (one computation, all surfaces;
 *     comparison page + per-source page + presentation export all read
 *     this single ChannelSnapshot shape)
 *   - bloom-constitution.md (forensic identity reconstruction — the
 *     story arc cells correspond to forensic Discovery / Validation /
 *     Broadcast / Cross-platform-footprint segments, NOT self-reported
 *     channel labels)
 *   - PROMPT-BIAS-AUDIT.md (v1-classified rows are counted out
 *     separately; the confidence_signals block surfaces the contamination
 *     percentage)
 *
 * What this does
 * --------------
 * Given (venueId, sourcePlatform, windowDays):
 *   1. Pages attribution_events for the venue (we already cap at 50k
 *      per venue — Rixey has ~430).
 *   2. Filters to the channel + window.
 *   3. Buckets into role / intent / story-arc segments.
 *   4. Joins weddings to compute funnel + booking value + lead time.
 *   5. Joins reviews (loose-match by couple) for review rating.
 *   6. Joins marketing_spend_records (substring match on .channel) for
 *      CAC numbers.
 *   7. Joins couple_intel for persona distribution.
 *   8. Stamps confidence_signals (prompt versions, freshness, v1 pct).
 *   9. Optionally upserts into channel_intel_snapshots.
 *
 * Deterministic. Same input rows → same output. Operator can force-
 * refresh whenever the underlying data shifts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import {
  normalisePlatform,
  platformToSlug,
  platformDisplayLabel,
  platformSpendChannelMatch,
} from './slugs'
import type {
  ChannelSnapshot,
  CostMetrics,
  FunnelBreakdown,
  IntentBreakdown,
  QualityMetrics,
  RoleBreakdown,
  SampleSizes,
  ConfidenceSignals,
  StoryArcCell,
  StoryArcSegment,
} from './types'

// Prompt versions flagged by Wave 21 / 22 as v1-biased.
const V1_CONTAMINATED_PROMPT_VERSIONS: ReadonlySet<string> = new Set([
  'channel-role-classifier.prompt.v1',
  'inquiry-intent-judge.prompt.v1',
])

const COMPUTE_FUNCTION_NAME = 'computeChannelSnapshot'

// ---------------------------------------------------------------------------
// Row shapes (only the columns the computer reads — keep narrow for speed)
// ---------------------------------------------------------------------------

interface AERow {
  id: string
  venue_id: string
  wedding_id: string | null
  source_platform: string | null
  role: string | null
  intent_class: string | null
  bucket: string | null
  tier: string | null
  signal_class: string | null
  prompt_version_classified_under: string | null
  intent_classified_at: string | null
  decided_at: string
}

interface WeddingRow {
  id: string
  status: string | null
  inquiry_date: string | null
  booked_at: string | null
  booking_value: number | null
}

interface TouchpointRow {
  wedding_id: string
  touch_type: string | null
  source: string | null
  occurred_at: string | null
}

interface ReviewRow {
  id: string
  rating: number | null
  wedding_id: string | null
  review_date: string | null
}

interface SpendRow {
  channel: string | null
  spend_date: string | null
  amount_cents: number | null
}

interface CoupleIntelRow {
  wedding_id: string | null
  persona_label: string | null
}

interface DisagreementRow {
  id: string
  axis: string
  stated_value: unknown
  forensic_value: unknown
  magnitude_score: number | null
  last_observed_at: string | null
}

const PAGE_SIZE = 1000

async function pageRows<T>(
  sb: SupabaseClient,
  table: string,
  columns: string,
  venueId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filterFn?: (q: any) => any,
): Promise<T[]> {
  const rows: T[] = []
  let from = 0
  while (rows.length < 50_000) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let q: any = sb.from(table).select(columns).eq('venue_id', venueId)
    if (filterFn) q = filterFn(q)
    q = q.range(from, from + PAGE_SIZE - 1)
    const { data, error } = await q
    if (error) throw new Error(`channel-intel-hub.load ${table}: ${error.message}`)
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }
  return rows
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2
  return sorted[mid]
}

function avg(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function safeRate(num: number, denom: number): number | null {
  if (denom <= 0) return null
  return num / denom
}

function emptyRoleBreakdown(): RoleBreakdown {
  return { acquisition: 0, validation: 0, conversion: 0, mixed: 0, unknown: 0 }
}

function emptyIntentBreakdown(): IntentBreakdown {
  return { targeted: 0, broadcast: 0, validation: 0, unknown: 0 }
}

function emptyStoryArcBreakdown(): Record<StoryArcSegment, number> {
  return {
    discovery: 0,
    inquiry: 0,
    validation: 0,
    broadcast: 0,
    cross_platform_footprint: 0,
  }
}

/** Tag an AE row with the story-arc segment(s) it belongs to. Single
 *  AE can belong to multiple segments (Discovery ⊂ Inquiry by design;
 *  cross_platform_footprint is mutually exclusive with the others). */
function tagStoryArcSegments(ae: AERow): StoryArcSegment[] {
  const segments: StoryArcSegment[] = []

  // Cross-platform footprint: Tenant 2 wide-AI nurture rows. NOT direct
  // inquiries — explicitly excluded from CAC math.
  if (ae.bucket === 'nurture' && ae.tier === 'tier_2_wide_ai') {
    segments.push('cross_platform_footprint')
    return segments // mutually exclusive
  }

  // Inquiry: any signal_class='source' attribution bucket.
  if (ae.signal_class === 'source' && ae.bucket === 'attribution') {
    segments.push('inquiry')
  }

  // Discovery: role=acquisition AND intent=targeted AND inquiry bucket.
  // (Subset of Inquiry — couples who actively chose this venue via this channel.)
  if (
    ae.role === 'acquisition' &&
    ae.intent_class === 'targeted' &&
    ae.bucket === 'attribution'
  ) {
    segments.push('discovery')
  }

  // Validation: role=validation. Couple found us elsewhere; this channel
  // was the intake/confirmation.
  if (ae.role === 'validation') {
    segments.push('validation')
  }

  // Broadcast: intent=broadcast. Platform auto-distributed to N venues.
  if (ae.intent_class === 'broadcast') {
    segments.push('broadcast')
  }

  return segments
}

const STORY_ARC_ANNOTATIONS: Record<StoryArcSegment, string> = {
  discovery:
    'Couples who actively chose this venue via this channel — role=acquisition AND intent=targeted. These are real channel-sourced inquiries.',
  inquiry:
    'All inquiries that landed via this channel (the form-fill happened here). Discovery is a subset.',
  validation:
    'Couples who found this venue elsewhere and used this channel as a confirmation/intake form. Crediting these as channel wins under-credits the real source.',
  broadcast:
    'Couples auto-distributed by the platform\'s "similar venues" ranker — the couple did not actively pick you. These should NOT carry full CAC weight.',
  cross_platform_footprint:
    'Couples with this channel in their cross-platform identity match (Tier 2 wide AI nurture), NOT direct inquiries. Excluded from CAC math.',
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ComputeChannelSnapshotArgs {
  venueId: string
  /** Canonical platform key (e.g. 'the_knot'). */
  sourcePlatform: string
  windowDays: number
  /** Persist the snapshot row. Default false — caller controls. */
  persist?: boolean
  /** Override Supabase (tests). */
  supabase?: SupabaseClient
}

/**
 * Compute one channel snapshot. Deterministic; safe to re-run.
 */
export async function computeChannelSnapshot(
  args: ComputeChannelSnapshotArgs,
): Promise<ChannelSnapshot> {
  const { venueId, windowDays, persist = false } = args
  const sb = args.supabase ?? createServiceClient()
  const canonicalPlatform = normalisePlatform(args.sourcePlatform)
  const channelSlug = platformToSlug(canonicalPlatform)
  const displayName = platformDisplayLabel(canonicalPlatform)

  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000)
  const windowStartIso = windowStart.toISOString()

  // -------------------------------------------------------------------------
  // Load attribution_events, filter to channel + window
  // -------------------------------------------------------------------------
  const allAEs = await pageRows<AERow>(
    sb,
    'attribution_events',
    'id, venue_id, wedding_id, source_platform, role, intent_class, bucket, tier, signal_class, prompt_version_classified_under, intent_classified_at, decided_at',
    venueId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q: any) => q.is('reverted_at', null).gte('decided_at', windowStartIso),
  )

  // Filter to canonical platform.
  const channelAEs = allAEs.filter(
    (a) => normalisePlatform(a.source_platform) === canonicalPlatform,
  )

  // -------------------------------------------------------------------------
  // Load weddings (only those referenced)
  // -------------------------------------------------------------------------
  const referencedWeddingIds = new Set<string>()
  for (const a of channelAEs) {
    if (a.wedding_id) referencedWeddingIds.add(a.wedding_id)
  }

  const weddings = await pageRows<WeddingRow>(
    sb,
    'weddings',
    'id, status, inquiry_date, booked_at, booking_value',
    venueId,
  )
  const weddingById = new Map<string, WeddingRow>()
  for (const w of weddings) weddingById.set(w.id, w)

  // -------------------------------------------------------------------------
  // Load wedding_touchpoints (for tour count)
  // -------------------------------------------------------------------------
  let touchpoints: TouchpointRow[] = []
  try {
    touchpoints = await pageRows<TouchpointRow>(
      sb,
      'wedding_touchpoints',
      'wedding_id, touch_type, source, occurred_at',
      venueId,
    )
  } catch {
    touchpoints = []
  }

  // -------------------------------------------------------------------------
  // Load marketing_spend_records, filter to channel + window
  // -------------------------------------------------------------------------
  let spend: SpendRow[] = []
  try {
    spend = await pageRows<SpendRow>(
      sb,
      'marketing_spend_records',
      'channel, spend_date, amount_cents',
      venueId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (q: any) => q.gte('spend_date', windowStartIso.slice(0, 10)),
    )
  } catch {
    spend = []
  }
  const channelSpend = spend.filter((s) => platformSpendChannelMatch(canonicalPlatform, s.channel))
  const spendCents = channelSpend.reduce((acc, s) => acc + (s.amount_cents ?? 0), 0)

  // -------------------------------------------------------------------------
  // Load reviews (loose-match by wedding) for quality
  // -------------------------------------------------------------------------
  let reviews: ReviewRow[] = []
  try {
    reviews = await pageRows<ReviewRow>(
      sb,
      'reviews',
      'id, rating, wedding_id, review_date',
      venueId,
    )
  } catch {
    reviews = []
  }

  // -------------------------------------------------------------------------
  // Load couple_intel for persona distribution
  // -------------------------------------------------------------------------
  let coupleIntel: CoupleIntelRow[] = []
  try {
    coupleIntel = await pageRows<CoupleIntelRow>(
      sb,
      'couple_intel',
      'wedding_id, persona_label',
      venueId,
    )
  } catch {
    coupleIntel = []
  }
  const personaByWeddingId = new Map<string, string>()
  for (const ci of coupleIntel) {
    if (ci.wedding_id && ci.persona_label) personaByWeddingId.set(ci.wedding_id, ci.persona_label)
  }

  // -------------------------------------------------------------------------
  // Load disagreement_findings (Wave 17) for this channel
  // -------------------------------------------------------------------------
  let disagreementCount = 0
  try {
    const disagreements = await pageRows<DisagreementRow>(
      sb,
      'disagreement_findings',
      'id, axis, stated_value, forensic_value, magnitude_score, last_observed_at',
      venueId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (q: any) => q.eq('axis', 'crm_source').eq('status', 'active'),
    )
    // Filter to those touching this channel — either stated or forensic
    // value matches the canonical platform.
    disagreementCount = disagreements.filter((d) => {
      const sv = String(d.stated_value ?? '').toLowerCase()
      const fv = String(d.forensic_value ?? '').toLowerCase()
      const p = canonicalPlatform.toLowerCase()
      return sv.includes(p) || fv.includes(p)
    }).length
  } catch {
    disagreementCount = 0
  }

  // -------------------------------------------------------------------------
  // Venue label
  // -------------------------------------------------------------------------
  let venueLabel = 'venue'
  try {
    const { data: venueRow } = await sb.from('venues').select('name').eq('id', venueId).maybeSingle()
    if (venueRow && typeof (venueRow as { name?: string }).name === 'string') {
      venueLabel = (venueRow as { name: string }).name
    }
  } catch {
    venueLabel = 'venue'
  }

  // -------------------------------------------------------------------------
  // Bucket counts
  // -------------------------------------------------------------------------
  const role_breakdown = emptyRoleBreakdown()
  const intent_breakdown = emptyIntentBreakdown()
  const storyArcRowsBySegment: Record<StoryArcSegment, AERow[]> = {
    discovery: [],
    inquiry: [],
    validation: [],
    broadcast: [],
    cross_platform_footprint: [],
  }

  const uniqueWeddingIdsAll = new Set<string>()
  const uniqueWeddingIdsByRole: Record<string, Set<string>> = {
    acquisition: new Set(),
    validation: new Set(),
    conversion: new Set(),
    mixed: new Set(),
    unknown: new Set(),
  }
  const uniqueWeddingIdsByIntent: Record<string, Set<string>> = {
    targeted: new Set(),
    broadcast: new Set(),
    validation: new Set(),
    unknown: new Set(),
  }

  let v1ContaminatedCount = 0
  let v2ClassifiedCount = 0
  let nullClassifiedCount = 0
  const promptVersionsUsed = new Set<string>()
  let dataFreshness = '1970-01-01T00:00:00Z'

  for (const ae of channelAEs) {
    if (ae.wedding_id) uniqueWeddingIdsAll.add(ae.wedding_id)

    const role = (ae.role ?? 'unknown') as keyof RoleBreakdown
    if (role in role_breakdown) {
      role_breakdown[role] += 1
      if (ae.wedding_id) uniqueWeddingIdsByRole[role]?.add(ae.wedding_id)
    } else {
      role_breakdown.unknown += 1
      if (ae.wedding_id) uniqueWeddingIdsByRole.unknown.add(ae.wedding_id)
    }

    const intent = (ae.intent_class ?? 'unknown') as keyof IntentBreakdown
    if (intent in intent_breakdown) {
      intent_breakdown[intent] += 1
      if (ae.wedding_id) uniqueWeddingIdsByIntent[intent]?.add(ae.wedding_id)
    } else {
      intent_breakdown.unknown += 1
      if (ae.wedding_id) uniqueWeddingIdsByIntent.unknown.add(ae.wedding_id)
    }

    const segs = tagStoryArcSegments(ae)
    for (const seg of segs) storyArcRowsBySegment[seg].push(ae)

    if (ae.prompt_version_classified_under) {
      promptVersionsUsed.add(ae.prompt_version_classified_under)
      if (V1_CONTAMINATED_PROMPT_VERSIONS.has(ae.prompt_version_classified_under)) {
        v1ContaminatedCount += 1
      } else {
        v2ClassifiedCount += 1
      }
    } else {
      nullClassifiedCount += 1
    }

    const freshCandidate = ae.intent_classified_at ?? ae.decided_at
    if (freshCandidate && freshCandidate > dataFreshness) dataFreshness = freshCandidate
  }

  if (dataFreshness === '1970-01-01T00:00:00Z') {
    dataFreshness = new Date().toISOString()
  }

  // -------------------------------------------------------------------------
  // Story-arc cell construction
  // -------------------------------------------------------------------------
  const storyArc: StoryArcCell[] = (
    [
      'discovery',
      'inquiry',
      'validation',
      'broadcast',
      'cross_platform_footprint',
    ] as StoryArcSegment[]
  ).map((seg) => buildStoryArcCell(seg, storyArcRowsBySegment[seg], weddingById, touchpoints))

  // -------------------------------------------------------------------------
  // Funnel breakdown (inquiry-bucket AEs as the inquiry denominator)
  // -------------------------------------------------------------------------
  const inquiryWeddings = new Set<string>()
  const tourWeddings = new Set<string>()
  const bookedWeddings = new Set<string>()

  // An inquiry is an AE in attribution bucket. A tour is when the
  // wedding has a tour_booked/tour_conducted touchpoint OR a status
  // tracking field indicating a tour fired.
  for (const ae of channelAEs) {
    if (!ae.wedding_id) continue
    if (ae.bucket === 'attribution') inquiryWeddings.add(ae.wedding_id)
  }
  for (const tp of touchpoints) {
    if (!inquiryWeddings.has(tp.wedding_id)) continue
    const t = (tp.touch_type ?? '').toLowerCase()
    if (t.includes('tour') || t === 'tour_booked' || t === 'tour_conducted') {
      tourWeddings.add(tp.wedding_id)
    }
  }
  for (const wid of inquiryWeddings) {
    const w = weddingById.get(wid)
    if (!w) continue
    if (w.status === 'booked' || w.booked_at !== null) bookedWeddings.add(wid)
  }

  const funnel: FunnelBreakdown = {
    inquiries: inquiryWeddings.size,
    tours: tourWeddings.size,
    booked: bookedWeddings.size,
    inquiry_to_tour_rate_0_1: safeRate(tourWeddings.size, inquiryWeddings.size),
    tour_to_booked_rate_0_1: safeRate(bookedWeddings.size, tourWeddings.size),
    inquiry_to_booked_rate_0_1: safeRate(bookedWeddings.size, inquiryWeddings.size),
    drop_inquiry_to_tour_0_1: inquiryWeddings.size > 0
      ? 1 - (tourWeddings.size / inquiryWeddings.size)
      : null,
    drop_tour_to_booked_0_1: tourWeddings.size > 0
      ? 1 - (bookedWeddings.size / tourWeddings.size)
      : null,
  }

  // -------------------------------------------------------------------------
  // Cost metrics (the headline reveal)
  // -------------------------------------------------------------------------
  // Apparent CAC: spend / all booked weddings attributed to this channel.
  // Real CAC excluding broadcast: spend / (booked weddings whose AE intent != broadcast).
  // Real CAC excluding broadcast AND cross-platform-footprint: spend / (Discovery + Validation booked).
  const bookedAEWeddingIntents = new Map<string, string>()
  for (const ae of channelAEs) {
    if (!ae.wedding_id) continue
    if (!bookedWeddings.has(ae.wedding_id)) continue
    if (!bookedAEWeddingIntents.has(ae.wedding_id) && ae.intent_class) {
      bookedAEWeddingIntents.set(ae.wedding_id, ae.intent_class)
    }
  }
  const bookedExcludingBroadcast = new Set<string>()
  for (const wid of bookedWeddings) {
    const intent = bookedAEWeddingIntents.get(wid)
    if (intent !== 'broadcast') bookedExcludingBroadcast.add(wid)
  }

  // Discovery + Validation booked
  const discoveryAndValidationBooked = new Set<string>()
  const discoveryWids = new Set(storyArcRowsBySegment.discovery.map((a) => a.wedding_id).filter((x): x is string => !!x))
  const validationWids = new Set(storyArcRowsBySegment.validation.map((a) => a.wedding_id).filter((x): x is string => !!x))
  for (const wid of bookedWeddings) {
    if (discoveryWids.has(wid) || validationWids.has(wid)) {
      discoveryAndValidationBooked.add(wid)
    }
  }

  const cost_metrics: CostMetrics = {
    spend_cents: spendCents,
    cac_cents:
      spendCents > 0 && bookedWeddings.size > 0
        ? Math.round(spendCents / bookedWeddings.size)
        : null,
    cac_excluding_broadcast_cents:
      spendCents > 0 && bookedExcludingBroadcast.size > 0
        ? Math.round(spendCents / bookedExcludingBroadcast.size)
        : null,
    cac_excluding_broadcast_and_crossplatform_cents:
      spendCents > 0 && discoveryAndValidationBooked.size > 0
        ? Math.round(spendCents / discoveryAndValidationBooked.size)
        : null,
    cost_per_inquiry_cents:
      spendCents > 0 && inquiryWeddings.size > 0
        ? Math.round(spendCents / inquiryWeddings.size)
        : null,
    cost_per_tour_cents:
      spendCents > 0 && tourWeddings.size > 0
        ? Math.round(spendCents / tourWeddings.size)
        : null,
  }

  // -------------------------------------------------------------------------
  // Quality metrics
  // -------------------------------------------------------------------------
  const bookingValues: number[] = []
  const leadTimes: number[] = []
  for (const wid of bookedWeddings) {
    const w = weddingById.get(wid)
    if (!w) continue
    if (w.booking_value !== null) bookingValues.push(w.booking_value * 100) // dollars → cents
    if (w.inquiry_date && w.booked_at) {
      const i = Date.parse(w.inquiry_date)
      const b = Date.parse(w.booked_at)
      if (Number.isFinite(i) && Number.isFinite(b) && b > i) {
        leadTimes.push((b - i) / (1000 * 60 * 60 * 24))
      }
    }
  }
  // Reviews loose-matched: a review on a wedding that landed via this channel.
  const channelWeddingIds = new Set(uniqueWeddingIdsAll)
  const channelReviews = reviews.filter(
    (r) => r.wedding_id !== null && channelWeddingIds.has(r.wedding_id),
  )
  const ratings = channelReviews
    .map((r) => r.rating)
    .filter((r): r is number => r !== null && Number.isFinite(r))

  const personaDistribution: Record<string, number> = {}
  for (const wid of channelWeddingIds) {
    const p = personaByWeddingId.get(wid)
    if (!p) continue
    personaDistribution[p] = (personaDistribution[p] ?? 0) + 1
  }

  const quality_metrics: QualityMetrics = {
    avg_booking_value_cents: avg(bookingValues) !== null ? Math.round(avg(bookingValues) as number) : null,
    median_lead_time_days: median(leadTimes) !== null ? Math.round((median(leadTimes) as number) * 10) / 10 : null,
    avg_review_rating: avg(ratings) !== null ? Math.round((avg(ratings) as number) * 10) / 10 : null,
    review_count: channelReviews.length,
    persona_distribution: personaDistribution,
  }

  // -------------------------------------------------------------------------
  // Sample sizes
  // -------------------------------------------------------------------------
  const weddings_per_role: RoleBreakdown = {
    acquisition: uniqueWeddingIdsByRole.acquisition.size,
    validation: uniqueWeddingIdsByRole.validation.size,
    conversion: uniqueWeddingIdsByRole.conversion.size,
    mixed: uniqueWeddingIdsByRole.mixed.size,
    unknown: uniqueWeddingIdsByRole.unknown.size,
  }
  const weddings_per_intent: IntentBreakdown = {
    targeted: uniqueWeddingIdsByIntent.targeted.size,
    broadcast: uniqueWeddingIdsByIntent.broadcast.size,
    validation: uniqueWeddingIdsByIntent.validation.size,
    unknown: uniqueWeddingIdsByIntent.unknown.size,
  }
  const weddings_per_story_arc: Record<StoryArcSegment, number> = emptyStoryArcBreakdown()
  for (const cell of storyArc) {
    weddings_per_story_arc[cell.segment] = cell.unique_weddings
  }

  const sample_sizes: SampleSizes = {
    unique_weddings: uniqueWeddingIdsAll.size,
    ae_total: channelAEs.length,
    weddings_per_role,
    weddings_per_intent,
    weddings_per_story_arc,
  }

  const confidence_signals: ConfidenceSignals = {
    v1_contaminated_count: v1ContaminatedCount,
    v2_classified_count: v2ClassifiedCount,
    null_classified_count: nullClassifiedCount,
    data_freshness_iso: dataFreshness,
    prompt_versions_used: [...promptVersionsUsed],
    window_days: windowDays,
    computed_with_function: COMPUTE_FUNCTION_NAME,
  }

  const snapshot: ChannelSnapshot = {
    venue_id: venueId,
    channel_slug: channelSlug,
    source_platform: canonicalPlatform,
    display_name: displayName,
    computed_at_iso: new Date().toISOString(),
    window_days: windowDays,
    role_breakdown,
    intent_breakdown,
    funnel,
    cost_metrics,
    quality_metrics,
    sample_sizes,
    confidence_signals,
    story_arc: storyArc,
    disagreement_findings_count: disagreementCount,
  }

  if (persist) {
    await persistSnapshot(sb, snapshot, venueLabel)
  }

  return snapshot
}

function buildStoryArcCell(
  segment: StoryArcSegment,
  rows: AERow[],
  weddingById: Map<string, WeddingRow>,
  touchpoints: TouchpointRow[],
): StoryArcCell {
  const wids = new Set<string>()
  const promptVersions = new Set<string>()
  let v1Count = 0
  for (const r of rows) {
    if (r.wedding_id) wids.add(r.wedding_id)
    if (r.prompt_version_classified_under) {
      promptVersions.add(r.prompt_version_classified_under)
      if (V1_CONTAMINATED_PROMPT_VERSIONS.has(r.prompt_version_classified_under)) v1Count += 1
    }
  }

  const tourWids = new Set<string>()
  for (const tp of touchpoints) {
    if (!wids.has(tp.wedding_id)) continue
    const t = (tp.touch_type ?? '').toLowerCase()
    if (t.includes('tour')) tourWids.add(tp.wedding_id)
  }
  const bookedWids = new Set<string>()
  const bookingValues: number[] = []
  for (const wid of wids) {
    const w = weddingById.get(wid)
    if (!w) continue
    if (w.status === 'booked' || w.booked_at !== null) {
      bookedWids.add(wid)
      if (w.booking_value !== null) bookingValues.push(w.booking_value * 100)
    }
  }

  return {
    segment,
    unique_weddings: wids.size,
    booked_weddings: bookedWids.size,
    tour_weddings: tourWids.size,
    conversion_to_tour_rate_0_1: safeRate(tourWids.size, wids.size),
    conversion_to_booked_rate_0_1: safeRate(bookedWids.size, wids.size),
    avg_booking_value_cents:
      avg(bookingValues) !== null ? Math.round(avg(bookingValues) as number) : null,
    sample_wedding_ids: [...wids].slice(0, 20),
    prompt_versions_used: [...promptVersions],
    v1_contaminated_pct: rows.length > 0 ? (v1Count / rows.length) * 100 : 0,
    annotation: STORY_ARC_ANNOTATIONS[segment],
  }
}

async function persistSnapshot(
  sb: SupabaseClient,
  snapshot: ChannelSnapshot,
  _venueLabel: string,
): Promise<void> {
  const { error } = await sb.from('channel_intel_snapshots').insert({
    venue_id: snapshot.venue_id,
    channel_slug: snapshot.channel_slug,
    source_platform: snapshot.source_platform,
    computed_at: snapshot.computed_at_iso,
    window_days: snapshot.window_days,
    role_breakdown: snapshot.role_breakdown,
    intent_breakdown: snapshot.intent_breakdown,
    funnel: snapshot.funnel,
    cost_metrics: snapshot.cost_metrics,
    quality_metrics: snapshot.quality_metrics,
    sample_sizes: snapshot.sample_sizes,
    confidence_signals: snapshot.confidence_signals,
  })
  if (error) {
    // Soft-fail: the snapshot is still returned to the caller. Cache miss
    // is preferable to a failed page render. Wave 24 reconciliation
    // pattern.
    // eslint-disable-next-line no-console
    console.warn('[channel-intel-hub] persist failed:', error.message)
  }
}

/**
 * List the distinct source_platforms for a venue's attribution_events,
 * collapsed to canonical platform keys. Used by the comparison page.
 *
 * Only platforms with >= minAeCount AE rows in the window are returned.
 */
export async function listChannelsForVenue(args: {
  venueId: string
  windowDays: number
  minAeCount?: number
  supabase?: SupabaseClient
}): Promise<Array<{ source_platform: string; channel_slug: string; ae_count: number }>> {
  const sb = args.supabase ?? createServiceClient()
  const minCount = args.minAeCount ?? 10
  const windowStart = new Date(Date.now() - args.windowDays * 24 * 60 * 60 * 1000)
  const rows = await pageRows<{ source_platform: string | null }>(
    sb,
    'attribution_events',
    'source_platform',
    args.venueId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (q: any) => q.is('reverted_at', null).gte('decided_at', windowStart.toISOString()),
  )
  const counts = new Map<string, number>()
  for (const r of rows) {
    const p = normalisePlatform(r.source_platform)
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  const out: Array<{ source_platform: string; channel_slug: string; ae_count: number }> = []
  for (const [platform, count] of counts.entries()) {
    if (count < minCount) continue
    out.push({
      source_platform: platform,
      channel_slug: platformToSlug(platform),
      ae_count: count,
    })
  }
  // Sort by count desc.
  out.sort((a, b) => b.ae_count - a.ae_count)
  return out
}
