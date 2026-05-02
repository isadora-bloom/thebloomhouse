/**
 * T3-G: Source-mix counterfactual decomposition (Playbook INS-19.5.1).
 *
 * "If you reallocated 20% of <high-CAC source> spend to <low-CAC
 *  source>, what's the expected booking delta?"
 *
 * Rides ON TOP of the existing computeSourceQuality scorecard rather
 * than re-implementing per-source attribution — the scorecard is the
 * canonical CAC source, owns the multi-touch attribution logic, and
 * gets fixed in one place when attribution rules evolve.
 *
 * Bandaid traps avoided:
 *
 *   - Naive linear extrapolation (double spend → double bookings) →
 *     concave sqrt response curve: bookings(s) ≈ a*sqrt(s) where
 *     a = currentBookings / sqrt(currentSpend). Diminishing returns
 *     baked in.
 *
 *   - Reallocating to a source with no historical signal → eligible-
 *     source filter requires spendInWindow > 0 AND firstTouchBookings
 *     >= 2 AND costPerBooking != null. Sources outside this set are
 *     not candidates for receiving reallocated budget.
 *
 *   - Tiny CAC gap producing a "noise reallocation" → require
 *     CAC_high / CAC_low >= 1.5 between candidate pair. Otherwise
 *     return null (no actionable insight).
 *
 *   - Sub-bookings projection ("reallocate $X for +0.2 bookings") →
 *     surface gating requires projected_delta_bookings >= 0.5.
 *
 *   - All-or-nothing reallocation (move 100% of budget) → recommend
 *     20% reallocation as the default, deltaCap at 50% so we never
 *     suggest moving more than half of source A's budget.
 *
 *   - LLM hallucinating per-source CAC / bookings → numbers-guard
 *     locks narration to {high.spend, low.spend, high.bookings,
 *     low.bookings, high.cpb, low.cpb, reallocation_amount,
 *     projected_delta_bookings}.
 *
 *   - Suspect attribution data going unflagged → if the candidate
 *     pair shows large autoLinkRate disparity (>30pp), flag a
 *     'attribution_quality_gap' in evidence and dampen confidence.
 *
 *   - Insufficient venue data → require >= 3 eligible sources AND
 *     >= 5 total firstTouchBookings in window. Otherwise return null.
 *
 *   - Empty marketing_spend → loadClassicalSourceMixEvidence returns
 *     null (graceful no-show).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'
import { computeSourceQuality, type SourceQualityRow } from '@/lib/services/source-quality'

export const SOURCE_MIX_COUNTERFACTUAL_PROMPT_VERSION = 'source-mix-counterfactual.prompt.v1.0'

const ANALYSIS_WINDOW_DAYS = 90
const MIN_ELIGIBLE_SOURCES = 3
const MIN_VENUE_BOOKINGS = 5
const MIN_SOURCE_BOOKINGS = 2
const MIN_CAC_RATIO = 1.5
const REALLOCATION_PCT = 0.20
const MAX_REALLOCATION_PCT = 0.50
const MIN_PROJECTED_DELTA_BOOKINGS = 0.5
const ATTRIBUTION_QUALITY_GAP_PP = 30

interface EligibleSource {
  source: string
  spendInWindow: number
  firstTouchBookings: number
  /** $ per booking. */
  costPerBooking: number
  autoLinkRate: number  // 0..1
  /** sqrt-curve coefficient: bookings = a * sqrt(spend). */
  responseCoefficient: number
}

interface SourceMixPair {
  high: EligibleSource  // higher CAC = the donor
  low: EligibleSource   // lower CAC = the recipient
  cac_ratio: number     // high.cpb / low.cpb
  reallocation_amount: number  // $ moved from high → low
  projected_donor_loss: number   // bookings lost from high
  projected_recipient_gain: number  // bookings gained on low
  projected_delta_bookings: number  // gain - loss; positive = net win
  attribution_quality_gap_flag: boolean
}

interface ClassicalSourceMixPayload {
  venueId: string
  windowDays: number
  total_eligible_sources: number
  total_window_bookings: number
  pair: SourceMixPair
  /** Echoed for narration context — top 5 by CAC. */
  per_source_summary: Array<Pick<EligibleSource, 'source' | 'spendInWindow' | 'firstTouchBookings' | 'costPerBooking'>>
}

/**
 * Pure helper — concave sqrt response curve. Calibrated from the
 * source's own current (spend, bookings) point: a = bookings / sqrt(spend).
 *
 * - bookingsAt(spend, a) = a * sqrt(spend)
 *
 * Returns 0 for non-positive spend (cleanly handles "remove all budget").
 */
export function bookingsAt(spend: number, coefficient: number): number {
  if (spend <= 0) return 0
  return coefficient * Math.sqrt(spend)
}

/**
 * Marginal change in bookings from changing spend by deltaSpend.
 * Positive deltaSpend = adding budget; negative = removing.
 * The result is signed bookings (positive = gain, negative = loss).
 */
export function marginalBookingsDelta(currentSpend: number, deltaSpend: number, coefficient: number): number {
  const newSpend = Math.max(0, currentSpend + deltaSpend)
  return bookingsAt(newSpend, coefficient) - bookingsAt(currentSpend, coefficient)
}

/**
 * Pick the donor / recipient pair from eligible sources.
 * Donor = source with HIGHEST cost-per-booking (worst efficiency).
 * Recipient = source with LOWEST cost-per-booking (best efficiency).
 */
export function pickPair(eligible: EligibleSource[]): { donor: EligibleSource; recipient: EligibleSource } | null {
  if (eligible.length < 2) return null
  let donor = eligible[0]
  let recipient = eligible[0]
  for (const s of eligible) {
    if (s.costPerBooking > donor.costPerBooking) donor = s
    if (s.costPerBooking < recipient.costPerBooking) recipient = s
  }
  if (donor.source === recipient.source) return null
  return { donor, recipient }
}

function projectReallocation(donor: EligibleSource, recipient: EligibleSource): SourceMixPair {
  // Move REALLOCATION_PCT of donor's budget to recipient, capped so
  // we never recommend moving more than MAX_REALLOCATION_PCT of donor.
  // The pct is a default; coordinator can scale on the recommendation.
  const reallocPct = Math.min(REALLOCATION_PCT, MAX_REALLOCATION_PCT)
  const reallocation_amount = Math.round(donor.spendInWindow * reallocPct)

  const projected_donor_loss = -marginalBookingsDelta(
    donor.spendInWindow, -reallocation_amount, donor.responseCoefficient,
  )  // sign-flip so loss is positive
  const projected_recipient_gain = marginalBookingsDelta(
    recipient.spendInWindow, reallocation_amount, recipient.responseCoefficient,
  )
  const projected_delta_bookings = projected_recipient_gain - projected_donor_loss

  const cac_ratio = donor.costPerBooking / recipient.costPerBooking
  // Round to 1 decimal of pp to avoid floating-point misses at the
  // exact threshold (e.g., 0.4 - 0.7 → -0.29999999999999996 → 29.999pp
  // < 30pp would silently mark a 30pp gap as non-flagged).
  const gapPp = Math.round(Math.abs(donor.autoLinkRate - recipient.autoLinkRate) * 1000) / 10
  const attribution_quality_gap_flag = gapPp >= ATTRIBUTION_QUALITY_GAP_PP

  return {
    high: donor,
    low: recipient,
    cac_ratio: Math.round(cac_ratio * 100) / 100,
    reallocation_amount,
    projected_donor_loss: Math.round(projected_donor_loss * 100) / 100,
    projected_recipient_gain: Math.round(projected_recipient_gain * 100) / 100,
    projected_delta_bookings: Math.round(projected_delta_bookings * 100) / 100,
    attribution_quality_gap_flag,
  }
}

function eligibleSourcesFromScorecard(rows: SourceQualityRow[]): EligibleSource[] {
  const eligible: EligibleSource[] = []
  for (const r of rows) {
    if (r.spendInWindow <= 0) continue
    if (r.firstTouchBookings < MIN_SOURCE_BOOKINGS) continue
    if (r.costPerBooking === null || r.costPerBooking <= 0) continue
    const responseCoefficient = r.firstTouchBookings / Math.sqrt(r.spendInWindow)
    eligible.push({
      source: r.source,
      spendInWindow: r.spendInWindow,
      firstTouchBookings: r.firstTouchBookings,
      costPerBooking: r.costPerBooking,
      autoLinkRate: r.autoLinkRate,
      responseCoefficient,
    })
  }
  return eligible
}

async function loadClassicalSourceMixEvidence(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ClassicalSourceMixPayload | null> {
  // Reuse the canonical scorecard. Don't re-implement attribution —
  // the scorecard owns the multi-touch logic.
  const rows = await computeSourceQuality(venueId, { windowDays: ANALYSIS_WINDOW_DAYS })
  void supabase  // computeSourceQuality opens its own service client; explicit param kept for symmetry

  const eligible = eligibleSourcesFromScorecard(rows)
  if (eligible.length < MIN_ELIGIBLE_SOURCES) return null

  const total_window_bookings = eligible.reduce((s, e) => s + e.firstTouchBookings, 0)
  if (total_window_bookings < MIN_VENUE_BOOKINGS) return null

  const pair = pickPair(eligible)
  if (!pair) return null

  if (pair.donor.costPerBooking / pair.recipient.costPerBooking < MIN_CAC_RATIO) return null

  const projection = projectReallocation(pair.donor, pair.recipient)
  if (projection.projected_delta_bookings < MIN_PROJECTED_DELTA_BOOKINGS) return null

  // Top 5 by CAC for the LLM context block.
  const per_source_summary = [...eligible]
    .sort((a, b) => b.costPerBooking - a.costPerBooking)
    .slice(0, 5)
    .map((e) => ({
      source: e.source,
      spendInWindow: Math.round(e.spendInWindow),
      firstTouchBookings: e.firstTouchBookings,
      costPerBooking: Math.round(e.costPerBooking),
    }))

  return {
    venueId,
    windowDays: ANALYSIS_WINDOW_DAYS,
    total_eligible_sources: eligible.length,
    total_window_bookings,
    pair: projection,
    per_source_summary,
  }
}

async function loadAiName(supabase: SupabaseClient, venueId: string): Promise<string> {
  const { data } = await supabase
    .from('venue_ai_config')
    .select('ai_name')
    .eq('venue_id', venueId)
    .maybeSingle()
  return ((data?.ai_name as string | undefined)?.trim()) || 'your assistant'
}

interface CounterfactualDiagnostic {
  reasoning: string
  recommendation: string
  confidence: number
}

export async function generateSourceMixCounterfactual(
  supabase: SupabaseClient,
  venueId: string,
  force: boolean = false,
  /** T5-eta.3 correlation id; persists onto the row. */
  correlationId: string | null = null,
): Promise<{
  donor: string
  recipient: string
  donor_spend: number
  recipient_spend: number
  donor_bookings: number
  recipient_bookings: number
  donor_cpb: number
  recipient_cpb: number
  cac_ratio: number
  reallocation_amount: number
  projected_donor_loss: number
  projected_recipient_gain: number
  projected_delta_bookings: number
  attribution_quality_gap_flag: boolean
  reasoning: string
  recommendation: string
  confidence: number
  cached: boolean
} | null> {
  const classical = await loadClassicalSourceMixEvidence(supabase, venueId)
  if (!classical) return null

  const cacheKey = buildCacheKey({
    venueId,
    donor: classical.pair.high.source,
    recipient: classical.pair.low.source,
    donorSpend: Math.round(classical.pair.high.spendInWindow),
    recipientSpend: Math.round(classical.pair.low.spendInWindow),
    cacRatio: classical.pair.cac_ratio,
    delta: classical.pair.projected_delta_bookings,
    realloc: classical.pair.reallocation_amount,
    flag: classical.pair.attribution_quality_gap_flag,
  })

  if (!force) {
    // Use a synthetic context_id derived from the donor+recipient pair
    // so two different reallocation pairs for the same venue can both
    // persist. Pair changes → cache_key changes → row-update; pair
    // identity is encoded in context_id so listing surfaces can
    // differentiate.
    const contextId = `pair:${classical.pair.high.source}>${classical.pair.low.source}`
    const cached = await lookupCachedInsight(
      supabase, venueId, 'source_mix_counterfactual', contextId, cacheKey,
    )
    if (cached) {
      const dp = cached.data_points as Partial<ClassicalSourceMixPayload> & { recommendation?: string }
      return {
        donor: classical.pair.high.source,
        recipient: classical.pair.low.source,
        donor_spend: Math.round(classical.pair.high.spendInWindow),
        recipient_spend: Math.round(classical.pair.low.spendInWindow),
        donor_bookings: classical.pair.high.firstTouchBookings,
        recipient_bookings: classical.pair.low.firstTouchBookings,
        donor_cpb: Math.round(classical.pair.high.costPerBooking),
        recipient_cpb: Math.round(classical.pair.low.costPerBooking),
        cac_ratio: classical.pair.cac_ratio,
        reallocation_amount: classical.pair.reallocation_amount,
        projected_donor_loss: classical.pair.projected_donor_loss,
        projected_recipient_gain: classical.pair.projected_recipient_gain,
        projected_delta_bookings: classical.pair.projected_delta_bookings,
        attribution_quality_gap_flag: classical.pair.attribution_quality_gap_flag,
        reasoning: cached.body,
        recommendation: dp.recommendation ?? cached.action ?? '',
        confidence: cached.confidence,
        cached: true,
      }
    }
  }

  const aiName = await loadAiName(supabase, venueId)
  const sourceTable = classical.per_source_summary
    .map((s) => `  - ${s.source}: spend $${s.spendInWindow.toLocaleString()}, ${s.firstTouchBookings} bookings, CAC $${s.costPerBooking.toLocaleString()}`)
    .join('\n')

  const qualityFlag = classical.pair.attribution_quality_gap_flag
    ? `WARNING: ${classical.pair.high.source} and ${classical.pair.low.source} have very different auto-link rates (${(classical.pair.high.autoLinkRate * 100).toFixed(0)}% vs ${(classical.pair.low.autoLinkRate * 100).toFixed(0)}%). Attribution quality varies between them — treat the projection as suggestive, not exact.`
    : 'Attribution quality is comparable between the donor and recipient sources.'

  const systemPrompt = `You are ${aiName}, helping a wedding-venue coordinator
read a source-mix reallocation simulation.

Output JSON:
  - reasoning: 1 short sentence explaining WHY this reallocation looks
    favourable. Reference the CAC gap, sample sizes, and (if present) the
    attribution-quality flag.
  - recommendation: 1 sentence with a SPECIFIC action grounded in the
    numbers — name both sources, the dollar amount, and the projected
    booking delta. Add a caveat if the attribution-quality flag is set.
  - confidence: 0.0-1.0. Default 0.5. Higher when CAC gap is large
    (>=2x) AND attribution-quality flag is OFF AND venue has >=10
    bookings in window. Lower when sample is small or quality flag is on.

CRITICAL RULES:
- Numbers in your output must come from the user prompt. The only
  numbers you may use are per-source spend / bookings / CAC, the
  reallocation amount, the projected delta, and the CAC ratio.
- Never project beyond the recommended reallocation; the model uses a
  concave sqrt response curve and overshoots beyond MAX_REALLOCATION_PCT
  are unreliable.
- If attribution-quality flag is set, you MUST include a caveat in the
  recommendation ("verify attribution quality before reallocating").`

  const userPrompt = `SOURCE-MIX COUNTERFACTUAL DIAGNOSTIC

Window: last ${classical.windowDays} days
Eligible sources (>= ${MIN_SOURCE_BOOKINGS} bookings, >$0 spend, defined CAC): ${classical.total_eligible_sources}
Total window bookings (eligible sources only): ${classical.total_window_bookings}

Top sources by CAC (highest = least efficient):
${sourceTable}

Recommended reallocation pair:
  - DONOR (highest CAC):    ${classical.pair.high.source}
      spend in window: $${Math.round(classical.pair.high.spendInWindow).toLocaleString()}
      bookings:        ${classical.pair.high.firstTouchBookings}
      CAC:             $${Math.round(classical.pair.high.costPerBooking).toLocaleString()}
  - RECIPIENT (lowest CAC): ${classical.pair.low.source}
      spend in window: $${Math.round(classical.pair.low.spendInWindow).toLocaleString()}
      bookings:        ${classical.pair.low.firstTouchBookings}
      CAC:             $${Math.round(classical.pair.low.costPerBooking).toLocaleString()}
  - CAC ratio: ${classical.pair.cac_ratio}x

Reallocation simulation (concave sqrt response curve):
  - Move:     $${classical.pair.reallocation_amount.toLocaleString()} from ${classical.pair.high.source} → ${classical.pair.low.source}
  - Donor projected loss:     ${classical.pair.projected_donor_loss} bookings
  - Recipient projected gain: ${classical.pair.projected_recipient_gain} bookings
  - Net projected delta:      +${classical.pair.projected_delta_bookings} bookings

${qualityFlag}

Diagnose + recommend.`

  let result: CounterfactualDiagnostic | null = null
  // Cost-ceiling gate (T5-α.2). Deterministic fallback below covers
  // paused case.
  const gate = await gateForBrainCall(venueId)
  if (gate.ok) {
    try {
      const raw = await callAIJson<CounterfactualDiagnostic>({
        systemPrompt,
        userPrompt,
        maxTokens: 320,
        temperature: 0.3,
        venueId,
        taskType: 'source_mix_counterfactual',
        tier: 'sonnet',
        promptVersion: SOURCE_MIX_COUNTERFACTUAL_PROMPT_VERSION,
      })
      if (raw && typeof raw.reasoning === 'string') {
        result = {
          reasoning: raw.reasoning.trim() || 'Reallocation projection computed.',
          recommendation: (raw.recommendation ?? '').trim() || 'Move the recommended amount and watch for 2 bookings to confirm before scaling.',
          confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
        }
      }
    } catch (err) {
      // PII redaction — prompt is venue-aggregate spend/booking data;
      // unlikely to carry PII but Anthropic 4xx still echoes prompt
      // text and we standardise the catch shape across T3. OPS-21.3.3.
      console.warn('[source-mix-counterfactual] LLM diagnostic failed:', redactError(err))
    }
  }

  // Deterministic fallback.
  if (!result) {
    const flagCaveat = classical.pair.attribution_quality_gap_flag
      ? ' Verify the attribution-quality gap before reallocating, since auto-link rates differ.'
      : ''
    result = {
      reasoning: 'CAC gap and concave-curve projection both indicate a net booking gain (LLM diagnostic unavailable).',
      recommendation: `Move $${classical.pair.reallocation_amount.toLocaleString()} from ${classical.pair.high.source} to ${classical.pair.low.source} for an expected +${classical.pair.projected_delta_bookings} bookings over the next ${classical.windowDays} days.${flagCaveat}`,
      confidence: classical.pair.attribution_quality_gap_flag ? 0.4 : 0.55,
    }
  }

  // Numbers narration may reference. Include both raw and rounded
  // forms so "$10,000" matches an integer 10000.
  const allowedNumbers: Array<number | string> = [
    Math.round(classical.pair.high.spendInWindow),
    Math.round(classical.pair.low.spendInWindow),
    classical.pair.high.firstTouchBookings,
    classical.pair.low.firstTouchBookings,
    Math.round(classical.pair.high.costPerBooking),
    Math.round(classical.pair.low.costPerBooking),
    classical.pair.cac_ratio,
    classical.pair.reallocation_amount,
    classical.pair.projected_donor_loss,
    classical.pair.projected_recipient_gain,
    classical.pair.projected_delta_bookings,
    classical.windowDays,
    classical.total_eligible_sources,
    classical.total_window_bookings,
  ]

  const evidence: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: {
      ...classical,
      reasoning: result.reasoning,
      recommendation: result.recommendation,
      llm_confidence: result.confidence,
    } as unknown as Record<string, unknown>,
    sampleSize: classical.total_window_bookings,
    // Effect size is bounded by CAC ratio scaled into [0,1]:
    // ratio 1.5 → 0.25, ratio 3 → 0.6, ratio 5+ → 0.8.
    effectSize: Math.min(0.8, (classical.pair.cac_ratio - 1) / 5),
  }
  // Damp confidence when attribution quality is suspect.
  let conf = confidenceFor({ sampleSize: evidence.sampleSize, effectSize: evidence.effectSize })
  if (classical.pair.attribution_quality_gap_flag) {
    conf = { ...conf, value: Math.min(conf.value, 0.4), level: 'low' }
  }

  const narration: InsightNarration = {
    title: `Source-mix: ${classical.pair.high.source} → ${classical.pair.low.source} reallocation`,
    body: result.reasoning,
    action: result.recommendation,
  }

  await persistInsight(supabase, {
    venueId,
    insightType: 'source_mix_counterfactual',
    contextId: `pair:${classical.pair.high.source}>${classical.pair.low.source}`,
    category: 'source_attribution',
    surfaceLayer: 'on_demand',
    classical: evidence,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: SOURCE_MIX_COUNTERFACTUAL_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: classical.pair.projected_delta_bookings * 10 + classical.total_window_bookings,
    priority: classical.pair.projected_delta_bookings >= 3 ? 'high'
      : classical.pair.projected_delta_bookings >= 1 ? 'medium'
      : 'low',
    correlationId,
  })

  return {
    donor: classical.pair.high.source,
    recipient: classical.pair.low.source,
    donor_spend: Math.round(classical.pair.high.spendInWindow),
    recipient_spend: Math.round(classical.pair.low.spendInWindow),
    donor_bookings: classical.pair.high.firstTouchBookings,
    recipient_bookings: classical.pair.low.firstTouchBookings,
    donor_cpb: Math.round(classical.pair.high.costPerBooking),
    recipient_cpb: Math.round(classical.pair.low.costPerBooking),
    cac_ratio: classical.pair.cac_ratio,
    reallocation_amount: classical.pair.reallocation_amount,
    projected_donor_loss: classical.pair.projected_donor_loss,
    projected_recipient_gain: classical.pair.projected_recipient_gain,
    projected_delta_bookings: classical.pair.projected_delta_bookings,
    attribution_quality_gap_flag: classical.pair.attribution_quality_gap_flag,
    reasoning: result.reasoning,
    recommendation: result.recommendation,
    confidence: conf.value,
    cached: false,
  }
}

// Re-exports for unit tests — pure helpers.
export const __test__ = {
  bookingsAt,
  marginalBookingsDelta,
  pickPair,
  eligibleSourcesFromScorecard,
  projectReallocation,
  ANALYSIS_WINDOW_DAYS,
  MIN_ELIGIBLE_SOURCES,
  MIN_VENUE_BOOKINGS,
  MIN_SOURCE_BOOKINGS,
  MIN_CAC_RATIO,
  REALLOCATION_PCT,
  MAX_REALLOCATION_PCT,
  MIN_PROJECTED_DELTA_BOOKINGS,
  ATTRIBUTION_QUALITY_GAP_PP,
}
