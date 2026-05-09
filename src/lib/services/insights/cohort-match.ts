/**
 * T3-D: Cohort match insight (Playbook INS-19.3.8 + ARCH-19.8-D).
 *
 * "What does the venue's track record with leads like this one
 * actually look like?" — for a current lead, pulls the K=10 most-
 * similar past weddings at the same venue, computes outcome stats
 * (conversion, median value, median days-to-book) over BOTH booked
 * and lost members so the cohort isn't pre-selected on success, and
 * narrates a 1-2 sentence diagnostic + a cause-grounded recommendation.
 *
 * Bandaid traps avoided:
 *   - Fake similarity from raw value diffs → z-score numeric dims
 *     against the venue's own distribution, exp(-z) → similarity.
 *   - Selection bias from cohort = booked-only → cohort includes BOTH
 *     'booked' and 'lost' so conversion rate is computed on the
 *     combined denominator.
 *   - Tiny cohorts ("based on 2 similar weddings" = noise) → N >= 3
 *     hard floor, return null otherwise.
 *   - Cross-venue privacy leak → strictly same venue_id.
 *   - Stale cohort (2018 weddings vs 2026 lead) → 3-year recency cap.
 *   - LLM hallucinating cohort details → numbers-guard restricts
 *     narration to {N_total, N_booked, N_lost, conversion_pct,
 *     median_value, median_days_to_book}.
 *   - Missing features tank distance to 0 spuriously → null dims are
 *     dropped from similarity, weights renormalised over present dims.
 *
 * Surfaces: lead detail (LeadInsightsPanel) — coordinator sees "12
 * similar past leads, 8/12 booked" with cause-grounded recommendation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { buildCoordinatorPrompt } from '@/lib/ai/coordinator-prompt'
import { loadAutoContextForWedding } from '@/lib/services/identity/auto-context-loader'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

// 2026-05-09 LLM-CALL-INVENTORY personality drift #3: bumped to v2.0
// when migrated to the canonical coordinator-prompt assembler.
//
// 2026-05-09 Wave 1B: bumped to v2.1. The FOCAL couple's auto-context
// notes flow into the diagnostic prompt so the cohort recommendation
// is shaped by the focal couple's emotional truths, not just by what
// past lookalikes did. Pattern + numerical taxonomy unchanged; the
// prose recommends "for couples in this cohort with financial-stress
// markers, the typical path is X" rather than ignoring the focal
// couple's context entirely. Cohort members' notes are NOT loaded —
// only the focal couple's, by design (cross-couple soft-context leakage
// would violate Tenant 1's privacy posture).
export const COHORT_MATCH_PROMPT_VERSION = 'cohort-match.prompt.v2.1'

const DAY_MS = 86_400_000
const COHORT_K = 10
// T5-ι.6 (2026-05-02): bumped from 3 → 5. Cohorts with N<5 cannot
// emit "High" confidence; below that the narrator forces a "Low conf
// — small comparison group" framing. Pairs with the
// confidence_flag (γ.1) disclosure logic so we never say "the venue's
// segment converts at X%" off four ambiguous data points.
const MIN_COHORT_SIZE = 5
// T5-ι.6: cohorts with fewer than this many qualifying members are
// forced to "Low" badge regardless of effect size. Three is the cliff
// at which median value/days-to-book stops being self-mocking
// (median of 2 is just an average; median of 3 starts to reject
// outliers).
const MIN_QUALIFYING_BANDS_FOR_HIGH = 3
const RECENCY_CAP_YEARS = 3

type Season = 'spring' | 'summer' | 'fall' | 'winter'

interface WeddingFeatures {
  weddingId: string
  status: string
  guest_count: number | null
  season: Season | null
  /** Days from inquiry to wedding_date. Null if either side missing. */
  planning_horizon_days: number | null
  source: string | null
  day_of_week: number | null
  wedding_date: string | null
  inquiry_date: string | null
  booking_value: number | null
  booked_at: string | null
}

interface VenueStats {
  guest_count_mean: number
  guest_count_std: number
  horizon_mean: number
  horizon_std: number
}

interface CohortMember {
  weddingId: string
  similarity: number
  status: string
  outcome: 'booked' | 'lost'
  booking_value: number | null
  /** Days from inquiry_date → booked_at. Null for lost or missing. */
  days_to_book: number | null
  /** weddings.confidence_flag — 'live' | 'imported_high' | ... | null.
   *  Drives γ.1 disclosure: cohorts with backfilled-low members get a
   *  "based on N high-fidelity + M backfilled-low" stamp on the
   *  narration so coordinator knows the comparison group is partly
   *  inferred from Gmail backfill rather than live pipeline. */
  confidence_flag: string | null
}

interface ClassicalCohortPayload {
  weddingId: string
  /** Features of the lead being matched. Recorded so re-runs against
   *  the same lead in the same shape skip narration. */
  current: WeddingFeatures
  /** The K nearest neighbors. */
  members: CohortMember[]
  n_total: number
  n_booked: number
  n_lost: number
  conversion_pct: number  // 0-100, rounded
  median_booking_value: number | null
  median_days_to_book: number | null
  /** Count of cohort members whose confidence_flag is one of
   *  'imported_low' | 'manual' | null. T5-γ.1 — narration calls this
   *  out explicitly so coordinator knows "of 8 booked, 3 are
   *  Gmail-backfill inferred". */
  n_low_confidence: number
  /** Count of cohort members with strong provenance (live or
   *  imported_high). Pre-fix the cohort blended these without
   *  acknowledgement. */
  n_high_confidence: number
}

function deriveSeason(wedding_date: string | null): Season | null {
  if (!wedding_date) return null
  const m = Number(wedding_date.slice(5, 7))
  if (!m || m < 1 || m > 12) return null
  if (m >= 3 && m <= 5) return 'spring'
  if (m >= 6 && m <= 8) return 'summer'
  if (m >= 9 && m <= 11) return 'fall'
  return 'winter'
}

function dayOfWeek(wedding_date: string | null): number | null {
  if (!wedding_date) return null
  const ts = Date.parse(wedding_date + 'T12:00:00Z')
  if (!Number.isFinite(ts)) return null
  return new Date(ts).getUTCDay()  // 0 = Sun, 6 = Sat
}

function planningHorizon(inquiry: string | null, weddingDate: string | null): number | null {
  if (!inquiry || !weddingDate) return null
  const a = Date.parse(inquiry)
  const b = Date.parse(weddingDate + 'T12:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return Math.round((b - a) / DAY_MS)
}

function featuresFromRow(r: {
  id: string
  status: string
  guest_count_estimate: number | null
  source: string | null
  wedding_date: string | null
  inquiry_date: string | null
  booking_value: number | null
  booked_at: string | null
}): WeddingFeatures {
  return {
    weddingId: r.id,
    status: r.status ?? 'inquiry',
    guest_count: r.guest_count_estimate ?? null,
    season: deriveSeason(r.wedding_date),
    planning_horizon_days: planningHorizon(r.inquiry_date, r.wedding_date),
    source: r.source ?? null,
    day_of_week: dayOfWeek(r.wedding_date),
    wedding_date: r.wedding_date,
    inquiry_date: r.inquiry_date,
    booking_value: r.booking_value ?? null,
    booked_at: r.booked_at,
  }
}

/** Population mean + sample stddev. Returns std=1 when N<2 (so z-score
 *  collapses to identity diff — graceful degradation rather than NaN). */
function meanStd(values: number[]): { mean: number; std: number } {
  const n = values.length
  if (n === 0) return { mean: 0, std: 1 }
  const mean = values.reduce((a, b) => a + b, 0) / n
  if (n < 2) return { mean, std: 1 }
  const v = values.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (n - 1)
  return { mean, std: Math.sqrt(v) || 1 }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

const FEATURE_WEIGHTS = {
  guest_count: 1.0,        // biggest operational-fit signal
  season: 0.8,             // pricing + availability tied to season
  planning_horizon: 0.6,   // long horizon = different couple psychology
  source: 0.5,             // same channel ≈ same demographic
  day_of_week: 0.4,        // Sat vs weekday differs but matters less
}

/**
 * Per-dim similarity in [0, 1]; null inputs return null (caller drops).
 * Numeric dims use exp(-|z_a - z_b|) so identical values → 1.0,
 * 1-stddev away → ~0.37, 2 → ~0.14. Categorical dims are 1 / 0.
 */
function dimSimilarity(
  a: WeddingFeatures,
  b: WeddingFeatures,
  stats: VenueStats,
): { gc: number | null; season: number | null; horizon: number | null; source: number | null; dow: number | null } {
  const gc = (a.guest_count !== null && b.guest_count !== null)
    ? Math.exp(-Math.abs((a.guest_count - stats.guest_count_mean) / stats.guest_count_std
                        - (b.guest_count - stats.guest_count_mean) / stats.guest_count_std))
    : null
  const season = (a.season !== null && b.season !== null)
    ? (a.season === b.season ? 1 : 0)
    : null
  const horizon = (a.planning_horizon_days !== null && b.planning_horizon_days !== null)
    ? Math.exp(-Math.abs((a.planning_horizon_days - stats.horizon_mean) / stats.horizon_std
                        - (b.planning_horizon_days - stats.horizon_mean) / stats.horizon_std))
    : null
  const source = (a.source !== null && b.source !== null)
    ? (a.source === b.source ? 1 : 0)
    : null
  const dow = (a.day_of_week !== null && b.day_of_week !== null)
    ? (a.day_of_week === b.day_of_week ? 1 : 0)
    : null
  return { gc, season, horizon, source, dow }
}

function combineSimilarity(
  d: ReturnType<typeof dimSimilarity>,
): { value: number; dimsUsed: number } {
  let total = 0
  let weight = 0
  let dims = 0
  if (d.gc !== null)      { total += d.gc * FEATURE_WEIGHTS.guest_count;    weight += FEATURE_WEIGHTS.guest_count;    dims++ }
  if (d.season !== null)  { total += d.season * FEATURE_WEIGHTS.season;     weight += FEATURE_WEIGHTS.season;         dims++ }
  if (d.horizon !== null) { total += d.horizon * FEATURE_WEIGHTS.planning_horizon; weight += FEATURE_WEIGHTS.planning_horizon; dims++ }
  if (d.source !== null)  { total += d.source * FEATURE_WEIGHTS.source;     weight += FEATURE_WEIGHTS.source;         dims++ }
  if (d.dow !== null)     { total += d.dow * FEATURE_WEIGHTS.day_of_week;   weight += FEATURE_WEIGHTS.day_of_week;    dims++ }
  if (weight === 0) return { value: 0, dimsUsed: 0 }
  return { value: total / weight, dimsUsed: dims }
}

async function loadClassicalCohortEvidence(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<ClassicalCohortPayload | null> {
  // Current lead.
  const { data: current } = await supabase
    .from('weddings')
    .select('id, venue_id, status, guest_count_estimate, source, wedding_date, inquiry_date, booking_value, booked_at')
    .eq('id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!current) return null

  const currentFeatures = featuresFromRow(current as Parameters<typeof featuresFromRow>[0])

  // Cohort candidates — same venue, terminal status, last 3 years,
  // not the current row.
  const cutoffMs = Date.now() - RECENCY_CAP_YEARS * 365 * DAY_MS
  const cutoff = new Date(cutoffMs).toISOString()

  const { data: candidates } = await supabase
    .from('weddings')
    .select('id, status, guest_count_estimate, source, wedding_date, inquiry_date, booking_value, booked_at, confidence_flag')
    .eq('venue_id', venueId)
    .neq('id', weddingId)
    .in('status', ['booked', 'completed', 'lost'])
    .gte('inquiry_date', cutoff)

  // T5-γ.1: keep confidence_flag on the raw candidate row so the
  // member can carry it into the disclosure. featuresFromRow doesn't
  // need it (it's not a similarity dim); we attach it side-channel.
  const candRows = (candidates ?? []) as Array<Parameters<typeof featuresFromRow>[0] & { confidence_flag: string | null }>
  const candList = candRows.map(featuresFromRow)
  const flagByWeddingId = new Map<string, string | null>(
    candRows.map((r) => [r.id, r.confidence_flag ?? null]),
  )
  if (candList.length < MIN_COHORT_SIZE) return null

  // Venue stats for z-scoring. Use ALL candidates to build the
  // distribution (not the current lead — keeps z-baseline stable).
  const guestCounts = candList.map((w) => w.guest_count).filter((v): v is number => v !== null)
  const horizons = candList.map((w) => w.planning_horizon_days).filter((v): v is number => v !== null)
  const guestStats = meanStd(guestCounts)
  const horizonStats = meanStd(horizons)
  const venueStats: VenueStats = {
    guest_count_mean: guestStats.mean,
    guest_count_std: guestStats.std,
    horizon_mean: horizonStats.mean,
    horizon_std: horizonStats.std,
  }

  // Score every candidate against the current lead. Drop candidates
  // that share zero comparable dims with the current lead — there's
  // no signal to compute similarity from.
  const scored: Array<CohortMember & { dimsUsed: number }> = []
  for (const cand of candList) {
    const dims = dimSimilarity(currentFeatures, cand, venueStats)
    const { value, dimsUsed } = combineSimilarity(dims)
    if (dimsUsed === 0) continue

    const outcome: 'booked' | 'lost' = (cand.status === 'booked' || cand.status === 'completed')
      ? 'booked' : 'lost'
    const daysToBook = (outcome === 'booked' && cand.inquiry_date && cand.booked_at)
      ? Math.round((Date.parse(cand.booked_at) - Date.parse(cand.inquiry_date)) / DAY_MS)
      : null

    scored.push({
      weddingId: cand.weddingId,
      similarity: value,
      status: cand.status,
      outcome,
      booking_value: cand.booking_value,
      days_to_book: daysToBook,
      confidence_flag: flagByWeddingId.get(cand.weddingId) ?? null,
      dimsUsed,
    })
  }

  // Take top-K. Tie-break on dims used (more dims compared = stronger
  // similarity claim) so we prefer well-matched over single-dim hits.
  const sorted = scored.sort((a, b) => {
    if (b.similarity !== a.similarity) return b.similarity - a.similarity
    return b.dimsUsed - a.dimsUsed
  }).slice(0, COHORT_K)
  if (sorted.length < MIN_COHORT_SIZE) return null

  const members: CohortMember[] = sorted.map(({ dimsUsed: _, ...m }) => m)
  const n_booked = members.filter((m) => m.outcome === 'booked').length
  const n_lost = members.length - n_booked
  const conversion_pct = Math.round((n_booked / members.length) * 100)
  // T5-γ.1: tally provenance. 'live' and 'imported_high' are strong;
  // 'imported_low' / 'manual' / null are flagged so the narration can
  // disclose the mix. 'imported_medium' counts as high here — partial
  // identity is still a real CRM record, not Gmail-backfill inference.
  const n_high_confidence = members.filter(
    (m) => m.confidence_flag === 'live'
      || m.confidence_flag === 'imported_high'
      || m.confidence_flag === 'imported_medium',
  ).length
  const n_low_confidence = members.length - n_high_confidence
  // booking_value is cents per Bloom convention (T5-Rixey-NN bug #8);
  // convert to dollars before computing median so the prompt + UI display
  // matches user expectations.
  const bookingValues = members
    .filter((m) => m.outcome === 'booked' && m.booking_value !== null)
    .map((m) => (m.booking_value as number) / 100)
  const daysToBookValues = members
    .filter((m) => m.days_to_book !== null)
    .map((m) => m.days_to_book as number)
  const median_booking_value = median(bookingValues)
  const median_days_to_book = median(daysToBookValues)

  return {
    weddingId,
    current: currentFeatures,
    members,
    n_total: members.length,
    n_booked,
    n_lost,
    conversion_pct,
    median_booking_value: median_booking_value !== null ? Math.round(median_booking_value) : null,
    median_days_to_book: median_days_to_book !== null ? Math.round(median_days_to_book) : null,
    n_low_confidence,
    n_high_confidence,
  }
}


interface CohortDiagnostic {
  pattern: 'high_converting' | 'low_converting' | 'mixed' | 'sparse_signal'
  reasoning: string
  recommendation: string
  confidence: number
}

export async function generateCohortMatch(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  force: boolean = false,
  /** T5-eta.3 correlation id; persists onto the row. */
  correlationId: string | null = null,
): Promise<{
  pattern: CohortDiagnostic['pattern']
  reasoning: string
  recommendation: string
  n_total: number
  n_booked: number
  n_lost: number
  conversion_pct: number
  median_booking_value: number | null
  median_days_to_book: number | null
  // T5-γ.1: surfaced so LeadInsightsPanel can render the disclosure
  // row ("based on N high-fidelity + M backfilled-low") without
  // re-querying. n_low_confidence > 0 → show disclosure.
  n_low_confidence: number
  n_high_confidence: number
  confidence: number
  cached: boolean
} | null> {
  const classical = await loadClassicalCohortEvidence(supabase, venueId, weddingId)
  if (!classical) return null

  const cacheKey = buildCacheKey({
    weddingId,
    // T5-delta.1 (2026-05-02). Current lead's inquiry_date in the
    // fingerprint — when coordinator corrects the date, planning
    // horizon shifts, similarity rankings shift, the narration is
    // stale. Belt-and-braces with migration 158's signature null-out.
    inquiryDateDay: classical.current.inquiry_date
      ? new Date(classical.current.inquiry_date).toISOString().slice(0, 10)
      : '',
    n: classical.n_total,
    booked: classical.n_booked,
    lost: classical.n_lost,
    conversion: classical.conversion_pct,
    medianValue: classical.median_booking_value,
    medianDays: classical.median_days_to_book,
    // T5-γ.1: confidence mix is part of the cache fingerprint so a
    // backfill that converts an imported_low into live re-narrates
    // (the disclosure stamp changes shape).
    nLow: classical.n_low_confidence,
    nHigh: classical.n_high_confidence,
    // Fingerprint of cohort membership — if the same N similar weddings
    // are chosen, narration is reusable.
    cohortIds: classical.members.map((m) => m.weddingId).sort().join('|'),
  })

  if (!force) {
    const cached = await lookupCachedInsight(
      supabase, venueId, 'cohort_match', weddingId, cacheKey,
    )
    if (cached) {
      const dp = cached.data_points as Partial<ClassicalCohortPayload> & {
        pattern?: CohortDiagnostic['pattern']
        recommendation?: string
      }
      return {
        pattern: dp.pattern ?? 'mixed',
        reasoning: cached.body,
        recommendation: dp.recommendation ?? cached.action ?? '',
        n_total: classical.n_total,
        n_booked: classical.n_booked,
        n_lost: classical.n_lost,
        conversion_pct: classical.conversion_pct,
        median_booking_value: classical.median_booking_value,
        median_days_to_book: classical.median_days_to_book,
        n_low_confidence: classical.n_low_confidence,
        n_high_confidence: classical.n_high_confidence,
        confidence: cached.confidence,
        cached: true,
      }
    }
  }

  // Brief the LLM on the cohort + the lead. Show booked vs lost
  // breakdown so the recommendation can lean on what differentiated
  // the converted from the unconverted.
  const sampleCohort = classical.members.slice(0, 5).map((m, i) =>
    `  ${i + 1}. ${m.outcome.toUpperCase()} (similarity ${m.similarity.toFixed(2)})`
    + (m.outcome === 'booked' && m.booking_value ? `, booked at $${Math.round(m.booking_value)}` : '')
    + (m.days_to_book !== null ? `, ${m.days_to_book} days to book` : ''),
  ).join('\n')

  const currentBlock = [
    `  - Guest count: ${classical.current.guest_count ?? 'unknown'}`,
    `  - Season: ${classical.current.season ?? 'unknown'}`,
    `  - Source: ${classical.current.source ?? 'unknown'}`,
    `  - Planning horizon: ${classical.current.planning_horizon_days ?? 'unknown'} days`,
    `  - Day of week: ${classical.current.day_of_week !== null ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][classical.current.day_of_week] : 'unknown'}`,
  ].join('\n')

  const taskInstructions = `Read the venue's track record with leads similar to this one.

Output JSON:
  - pattern: 'high_converting' (>= 70% booked) | 'low_converting' (<= 30%
    booked) | 'mixed' (in between) | 'sparse_signal' (cohort small enough
    that pattern is suggestive only).
  - reasoning: 1 short sentence. Reference cohort SIZE + conversion + (if
    relevant) which dim shaped the cohort (season, guest count, source).
  - recommendation: 1 sentence with a SPECIFIC action grounded in what
    DIFFERENTIATED the booked from the lost members of this cohort.
    Examples:
      - high_converting -> "Lean into your repeatable offer for this segment;
                            propose a tour within 5 days like the prior 6
                            who booked."
      - low_converting -> "This profile historically went elsewhere,
                          surface the differentiator early; consider a
                          discounted hold."
      - mixed -> "Outcome was split; book a tour and watch for the
                differentiator (specific question about pricing or a
                second visit)."
      - sparse_signal -> "Treat this as a fresh lead; cohort too small
                          to anchor on."
  - confidence: 0.0-1.0, how confident you are in the pattern. Default
    0.5 when conversion is split mid-range; higher for extreme rates.

CRITICAL RULES:
- Refer to the cohort by SHAPE only, never invent a name or quote.
- Do not claim causation from a small cohort. With < 10 members say
  "the venue's small look-alike sample suggests..." not "this segment
  always books."
- If a COUPLE'S NOTES block is present, those notes belong to the
  FOCAL couple (the lead being matched), NOT the cohort members. Use
  them to shape the recommendation's emotional posture (e.g. "for
  couples in this cohort carrying financial-stress markers, the
  differentiator that converts is X"). Never echo the focal couple's
  notes verbatim. Cohort members' inner state is unknown to you.`

  // T5-γ.1: include a confidence-mix disclosure line when any cohort
  // member is backfilled-low or has unknown provenance. Forces the
  // LLM to acknowledge the inferred portion in its reasoning rather
  // than narrating as if every cohort member is live-pipeline truth.
  const confidenceMixLine = classical.n_low_confidence > 0
    ? `  - Confidence mix: ${classical.n_high_confidence} high-fidelity + ${classical.n_low_confidence} backfilled-low (Gmail-inferred or coordinator hand-entry)`
    : `  - Confidence mix: ${classical.n_high_confidence} high-fidelity (live or CRM-imported)`

  const userPrompt = `COHORT MATCH DIAGNOSTIC

Current lead profile:
${currentBlock}

Look-alike cohort (same venue, last 3 years, top ${classical.n_total} matches):
  - Total members: ${classical.n_total}
  - Booked: ${classical.n_booked}
  - Lost: ${classical.n_lost}
  - Conversion: ${classical.conversion_pct}%
  - Median booking value (booked only): ${classical.median_booking_value !== null ? '$' + classical.median_booking_value : 'unknown'}
  - Median days-to-book: ${classical.median_days_to_book !== null ? classical.median_days_to_book + ' days' : 'unknown'}
${confidenceMixLine}

Top 5 cohort members (closest match):
${sampleCohort}

Diagnose the pattern + recommend an action.${classical.n_low_confidence > 0 ? ' If a meaningful share of the cohort is backfilled-low, acknowledge that the comparison group is partly inferred from Gmail backfill (one short clause is enough, the UI also surfaces the count separately).' : ''}`

  // Wave 1B (2026-05-09). Load the FOCAL couple's auto-context as
  // tone fuel for the recommendation. Cohort members' notes are NOT
  // loaded — Tenant 1 / Constitution §4 forbids cross-couple soft-
  // context leakage, even in aggregate. limit=8 — narrators have a
  // tighter context budget than the brain reply path. Best-effort:
  // the loader never throws; this try/catch is defense-in-depth.
  let coupleNotesBlock: string | null = null
  try {
    const auto = await loadAutoContextForWedding(supabase, weddingId, { limit: 8 })
    coupleNotesBlock = auto.brainBlock
  } catch (err) {
    console.warn('[cohort-match] auto-context load failed:', redactError(err))
  }

  const { systemPrompt, promptVersion, contentTier } = await buildCoordinatorPrompt({
    venueId,
    surface: 'narration_cohort',
    taskInstructions,
    coupleNotesBlock,
    numbersGuard: {
      n_total: classical.n_total,
      n_booked: classical.n_booked,
      n_lost: classical.n_lost,
      conversion_pct: classical.conversion_pct,
      median_booking_value: classical.median_booking_value,
      median_days_to_book: classical.median_days_to_book,
      n_low_confidence: classical.n_low_confidence,
      n_high_confidence: classical.n_high_confidence,
    },
    contentTier: 1,
  })

  let result: CohortDiagnostic | null = null
  // Cost-ceiling gate (T5-α.2). Conversion-rate fallback below covers
  // the paused case.
  const gate = await gateForBrainCall(venueId)
  if (gate.ok) {
    try {
      const raw = await callAIJson<CohortDiagnostic>({
        systemPrompt,
        userPrompt,
        maxTokens: 320,
        temperature: 0.3,
        venueId,
        taskType: 'cohort_match',
        tier: 'sonnet',
        promptVersion,
        contentTier,
      })
      if (raw && ['high_converting', 'low_converting', 'mixed', 'sparse_signal'].includes(raw.pattern)) {
        result = {
          pattern: raw.pattern,
          reasoning: (raw.reasoning ?? '').trim() || 'Cohort pattern inferred from outcome split.',
          recommendation: (raw.recommendation ?? '').trim() || 'Treat this as a fresh lead.',
          confidence: typeof raw.confidence === 'number'
            ? Math.max(0, Math.min(1, raw.confidence))
            : 0.5,
        }
      }
    } catch (err) {
      // PII redaction — prompt carries cohort wedding details + current
      // lead profile (guest count, season, source). OPS-21.3.3.
      console.warn('[cohort-match] LLM diagnostic failed:', redactError(err))
    }
  }

  // Deterministic fallback — pick pattern from conversion rate.
  if (!result) {
    let pattern: CohortDiagnostic['pattern']
    // T5-ι.6: sparse_signal gate uses MIN_QUALIFYING_BANDS_FOR_HIGH
    // (3) — even when N >= MIN_COHORT_SIZE (5) the absolute booked or
    // lost count needs to clear 3 to escape sparse_signal. Pre-fix a
    // 5-member cohort with 1 booked / 4 lost emitted high_converting
    // off a single data point.
    if (classical.n_total < MIN_COHORT_SIZE) pattern = 'sparse_signal'
    else if (classical.n_booked < MIN_QUALIFYING_BANDS_FOR_HIGH && classical.n_lost < MIN_QUALIFYING_BANDS_FOR_HIGH) pattern = 'sparse_signal'
    else if (classical.conversion_pct >= 70) pattern = 'high_converting'
    else if (classical.conversion_pct <= 30) pattern = 'low_converting'
    else pattern = 'mixed'

    const recommendation = pattern === 'high_converting'
      ? 'Lean into your repeatable offer for this segment; propose a tour this week.'
      : pattern === 'low_converting'
      ? 'This profile historically went elsewhere; lead with the differentiator early.'
      : pattern === 'sparse_signal'
      ? 'Treat as a fresh lead; cohort is too small to anchor on.'
      : 'Outcome split in the cohort; tour-then-watch is the right cadence.'

    // T5-γ.1: deterministic-path narration includes the disclosure when
    // backfilled-low members exist. LLM-path adds the same hint via
    // userPrompt so both paths produce honest narration.
    const baseReasoning = 'Pattern inferred from cohort conversion rate (LLM diagnostic unavailable).'
    const disclosure = classical.n_low_confidence > 0
      ? ` ${classical.n_low_confidence} of ${classical.n_total} cohort members are backfilled-low (Gmail-inferred).`
      : ''

    result = {
      pattern,
      reasoning: baseReasoning + disclosure,
      recommendation,
      confidence: 0.35,
    }
  }

  // Numbers the narration may reference. Include both raw and rounded
  // forms so the LLM saying "67%" matches a "0.67 → 67" classical
  // value.
  const allowedNumbers: Array<number | string> = [
    classical.n_total,
    classical.n_booked,
    classical.n_lost,
    classical.conversion_pct,
    classical.median_booking_value ?? 0,
    classical.median_days_to_book ?? 0,
    // Common denominators the LLM tends to phrase ("8 of 12 booked")
    // — both numerator and denominator already in the list above.
  ]

  const evidence: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: {
      ...classical,
      pattern: result.pattern,
      reasoning: result.reasoning,
      recommendation: result.recommendation,
      llm_confidence: result.confidence,
    } as unknown as Record<string, unknown>,
    sampleSize: classical.n_total,
    // Effect = how decisive the conversion split is. 100% or 0% → 1.0;
    // 50/50 → 0.0 (cohort signal carries no decision content). Maps to
    // a confidence score that's honest about ambiguous cohorts.
    effectSize: Math.abs(classical.conversion_pct - 50) / 50,
  }
  const conf = confidenceFor({
    sampleSize: evidence.sampleSize,
    effectSize: evidence.effectSize,
  })

  // T5-ι.6: cap confidence so cohorts with N < MIN_COHORT_SIZE or
  // fewer than MIN_QUALIFYING_BANDS_FOR_HIGH members in the dominant
  // outcome cannot emit a "High" badge. levelForConfidence in
  // inline-primitives.tsx maps >= 0.7 to High and >= 0.45 to Medium —
  // we clamp to 0.44 so the UI cap is "Low" regardless of effect
  // magnitude when the cohort is sparse. Pre-fix a 4-member cohort
  // with 4/4 booked could emit High off effectSize=1.0 even though
  // the sample size made the claim near-meaningless.
  const dominantBand = Math.max(classical.n_booked, classical.n_lost)
  const isSparseForHighBadge =
    classical.n_total < MIN_COHORT_SIZE
    || dominantBand < MIN_QUALIFYING_BANDS_FOR_HIGH
  const cappedConfidence = isSparseForHighBadge
    ? Math.min(conf.value, 0.44)
    : conf.value

  const narration: InsightNarration = {
    title: result.pattern === 'high_converting'
      ? `Look-alike cohort books at ${classical.conversion_pct}%`
      : result.pattern === 'low_converting'
      ? `Look-alike cohort converts at ${classical.conversion_pct}%`
      : result.pattern === 'sparse_signal'
      ? `Limited look-alike sample (${classical.n_total})`
      : `Mixed outcome cohort (${classical.n_booked}/${classical.n_total} booked)`,
    body: result.reasoning,
    action: result.recommendation,
  }

  await persistInsight(supabase, {
    venueId,
    insightType: 'cohort_match',
    contextId: weddingId,
    category: 'lead_conversion',
    // Conversion-warning cohorts surface inline; everything else is
    // on-demand so the panel doesn't get cluttered with informational
    // "yep, looks normal" rows.
    surfaceLayer: result.pattern === 'low_converting' ? 'inline' : 'on_demand',
    classical: evidence,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: COHORT_MATCH_PROMPT_VERSION,
    confidence: cappedConfidence,
    surfacePriority: classical.n_total + (result.pattern === 'low_converting' ? 50 : 0),
    priority: result.pattern === 'low_converting' ? 'high'
      : result.pattern === 'sparse_signal' ? 'low'
      : 'medium',
    correlationId,
  })

  return {
    pattern: result.pattern,
    reasoning: result.reasoning,
    recommendation: result.recommendation,
    n_total: classical.n_total,
    n_booked: classical.n_booked,
    n_lost: classical.n_lost,
    conversion_pct: classical.conversion_pct,
    median_booking_value: classical.median_booking_value,
    median_days_to_book: classical.median_days_to_book,
    n_low_confidence: classical.n_low_confidence,
    n_high_confidence: classical.n_high_confidence,
    confidence: cappedConfidence,
    cached: false,
  }
}

// Re-exports for unit tests — these helpers are pure.
export const __test__ = {
  deriveSeason,
  dayOfWeek,
  planningHorizon,
  meanStd,
  median,
  dimSimilarity,
  combineSimilarity,
}
