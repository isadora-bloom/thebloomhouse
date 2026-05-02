/**
 * T3-F: Pricing-elasticity insight (Playbook INS-19.5.2 + LIMB-16.2.3).
 *
 * For the most-recent base_price change in pricing_history, computes
 * the conversion-rate response: pre-window vs post-window inquiry →
 * booked rates. Numeric elasticity:
 *
 *   elasticity = ((post_conversion - pre_conversion) / pre_conversion)
 *              / ((new_price - old_price) / old_price)
 *
 * Bandaid traps avoided:
 *
 *   - Spurious elasticity from confounded marketing-spend changes →
 *     loadMarketingSpendChange detects pre-vs-post spend deltas; if
 *     |deltaPct| >= 20%, evidence flags a confound and the LLM is
 *     told "treat this elasticity as suspect" (drives the inconclusive
 *     classification).
 *
 *   - Selection bias from booked-only counts → conversion is computed
 *     on TERMINAL-status weddings (booked + completed + lost).
 *     Still-in-flight (inquiry / tour_scheduled / proposal_sent) are
 *     EXCLUDED from both numerator and denominator — they haven't
 *     resolved, so attributing them to either window distorts the
 *     rate.
 *
 *   - Tiny-window inference → require N_pre >= 8 AND N_post >= 8 of
 *     resolved weddings. Otherwise return null.
 *
 *   - Premature conclusions (price changed last week, 0 weddings
 *     resolved) → require change >= 60 days ago AND post-window
 *     >= 60 days. Otherwise return null.
 *
 *   - Multiple price changes muddying causality → if a SECOND base_price
 *     change occurred within 60 days before or after the analysis
 *     change, the analysis falls back to inconclusive. Caller can re-
 *     run when more time has passed.
 *
 *   - Zero-division on price-change percentage → filter out malformed
 *     pricing_history rows where old_value or new_value is null/zero.
 *
 *   - Field-name confusion (capacity / tier_structure / etc.
 *     misclassified as "price") → only field_name='base_price' rows
 *     drive this analysis. Non-base-price rows skipped.
 *
 *   - LLM hallucinating numbers → numbers-guard locks narration to
 *     {pre_conversion_pct, post_conversion_pct, pre_n, post_n,
 *     price_change_pct, elasticity}.
 *
 *   - Empty pricing_history (zero rows in seed / brand-new venue) →
 *     loadClassicalPricingEvidence returns null gracefully.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

export const PRICING_ELASTICITY_PROMPT_VERSION = 'pricing-elasticity.prompt.v1.0'

const DAY_MS = 86_400_000
const ANALYSIS_WINDOW_DAYS = 90
const MIN_POST_WINDOW_DAYS = 60
const MIN_DAYS_SINCE_CHANGE = 60
const ADJACENT_CHANGE_GAP_DAYS = 60
const MIN_PER_WINDOW_RESOLVED = 8
const MARKETING_CONFOUND_THRESHOLD_PCT = 20

type ElasticityClassification = 'elastic' | 'inelastic' | 'positive' | 'inconclusive'

const CLASSIFICATION_LABEL: Record<ElasticityClassification, string> = {
  elastic: 'Elastic — price-sensitive segment',
  inelastic: 'Inelastic — pricing power',
  positive: 'Positive elasticity — confound likely',
  inconclusive: 'Inconclusive — insufficient signal',
}

interface PricingChangeRow {
  id: string
  venue_id: string
  field_name: string
  old_value: { value?: number } | null
  new_value: { value?: number } | null
  changed_at: string
  notes: string | null
  context: string | null
}

interface ConversionWindow {
  windowStart: string
  windowEnd: string
  resolved: number       // booked + completed + lost
  booked: number         // booked + completed
  conversion_rate: number  // booked / resolved, 0..1
}

/** Compute conversion stats for a venue window. Terminal-status only.
 *  Filters on the RESOLUTION timestamp (booked_at for booked/completed,
 *  lost_at for lost) NOT on inquiry_date — otherwise a lead who
 *  inquired BEFORE a price change but only decided AFTER the change
 *  would land in the pre cohort even though their decision was made
 *  under the new price regime. T3 review P1 #10. */
async function loadConversionWindow(
  supabase: SupabaseClient,
  venueId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<ConversionWindow> {
  const startIso = windowStart.toISOString()
  const endIso = windowEnd.toISOString()

  // Pull all candidate weddings (terminal status), then filter in JS
  // by the resolution-timestamp rule. Two queries (one for booked,
  // one for lost) would hit different timestamp columns; combining
  // in-memory is cheaper than chaining .or() with column-specific
  // bounds and avoids a complex Supabase REST query.
  const { data } = await supabase
    .from('weddings')
    .select('status, booked_at, lost_at')
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed', 'lost'])
    // Pre-filter to give Postgres a chance to use the inquiry_date
    // index — anything before windowStart's earliest plausible
    // inquiry-to-decision lag (180 days) can't have a decision in
    // the window. Conservative + index-friendly.
    .gte('inquiry_date', new Date(windowStart.getTime() - 180 * 86_400_000).toISOString())

  const rows = ((data ?? []) as Array<{
    status: string
    booked_at: string | null
    lost_at: string | null
  }>)

  let booked = 0
  let resolved = 0
  for (const r of rows) {
    const resolutionTs = (r.status === 'booked' || r.status === 'completed')
      ? r.booked_at
      : r.lost_at
    if (!resolutionTs) continue  // status terminal but no resolution timestamp; skip
    if (resolutionTs < startIso || resolutionTs > endIso) continue
    resolved++
    if (r.status === 'booked' || r.status === 'completed') booked++
  }

  return {
    windowStart: startIso,
    windowEnd: endIso,
    resolved,
    booked,
    conversion_rate: resolved > 0 ? booked / resolved : 0,
  }
}

interface MarketingSpendDelta {
  pre_total: number
  post_total: number
  delta_pct: number  // (post - pre) / pre * 100; 0 if pre = 0
  is_confound: boolean
}

/** Sum marketing_spend in [start, end] across all sources. Used to
 *  detect a confounded comparison: if marketing spend swung >20%
 *  alongside the price change, the conversion-rate delta is
 *  confounded. */
async function loadMarketingSpendChange(
  supabase: SupabaseClient,
  venueId: string,
  preStart: Date,
  preEnd: Date,
  postStart: Date,
  postEnd: Date,
): Promise<MarketingSpendDelta | null> {
  const { data } = await supabase
    .from('marketing_spend')
    .select('month, amount')
    .eq('venue_id', venueId)
    .gte('month', preStart.toISOString().split('T')[0])
    .lte('month', postEnd.toISOString().split('T')[0])

  const rows = ((data ?? []) as Array<{ month: string; amount: number }>)
  if (rows.length === 0) return null  // no spend data → can't detect confound; treat as unknown

  let pre_total = 0
  let post_total = 0
  for (const r of rows) {
    const m = Date.parse(r.month + 'T12:00:00Z')
    if (m >= preStart.getTime() && m <= preEnd.getTime()) pre_total += Number(r.amount) || 0
    if (m >= postStart.getTime() && m <= postEnd.getTime()) post_total += Number(r.amount) || 0
  }

  const delta_pct = pre_total > 0
    ? ((post_total - pre_total) / pre_total) * 100
    : (post_total > 0 ? 100 : 0)

  return {
    pre_total: Math.round(pre_total),
    post_total: Math.round(post_total),
    delta_pct: Math.round(delta_pct * 10) / 10,
    is_confound: Math.abs(delta_pct) >= MARKETING_CONFOUND_THRESHOLD_PCT,
  }
}

interface ClassicalPricingPayload {
  venueId: string
  changeId: string
  changed_at: string
  old_price: number
  new_price: number
  price_change_pct: number  // signed, in percent points
  pre: ConversionWindow
  post: ConversionWindow
  elasticity: number | null
  marketing_spend: MarketingSpendDelta | null
  /** True if pricing_history has another base_price change within the
   *  ADJACENT_CHANGE_GAP_DAYS window — analysis is then untrustworthy
   *  and we degrade to inconclusive. */
  has_adjacent_change: boolean
  notes: string | null
}

/**
 * Compute elasticity classically. Returns null when any precondition
 * fails (insufficient data, premature analysis, malformed values).
 * Caller treats null as "no insight surface this run".
 */
async function loadClassicalPricingEvidence(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ClassicalPricingPayload | null> {
  // Most-recent base_price change.
  const { data: priceRows } = await supabase
    .from('pricing_history')
    .select('id, venue_id, field_name, old_value, new_value, changed_at, notes, context')
    .eq('venue_id', venueId)
    .eq('field_name', 'base_price')
    .order('changed_at', { ascending: false })
    .limit(1)

  const change = ((priceRows ?? []) as PricingChangeRow[])[0]
  if (!change) return null

  const old_price = Number(change.old_value?.value ?? NaN)
  const new_price = Number(change.new_value?.value ?? NaN)
  if (!Number.isFinite(old_price) || old_price <= 0) return null
  if (!Number.isFinite(new_price) || new_price <= 0) return null
  if (old_price === new_price) return null  // no actual price change

  const changeMs = Date.parse(change.changed_at)
  if (!Number.isFinite(changeMs)) return null

  // Premature analysis guard.
  const daysSinceChange = (Date.now() - changeMs) / DAY_MS
  if (daysSinceChange < MIN_DAYS_SINCE_CHANGE) return null

  // Adjacent-change check — any OTHER base_price change within
  // ±ADJACENT_CHANGE_GAP_DAYS would make the pre/post windows leak
  // across multiple interventions.
  const adjStart = new Date(changeMs - ADJACENT_CHANGE_GAP_DAYS * DAY_MS).toISOString()
  const adjEnd = new Date(changeMs + ADJACENT_CHANGE_GAP_DAYS * DAY_MS).toISOString()
  const { data: nearbyChanges } = await supabase
    .from('pricing_history')
    .select('id, changed_at')
    .eq('venue_id', venueId)
    .eq('field_name', 'base_price')
    .neq('id', change.id)
    .gte('changed_at', adjStart)
    .lte('changed_at', adjEnd)
  const has_adjacent_change = ((nearbyChanges ?? []) as Array<{ id: string }>).length > 0

  // Pre + post windows.
  const preStart = new Date(changeMs - ANALYSIS_WINDOW_DAYS * DAY_MS)
  const preEnd = new Date(changeMs)
  const postEnd = new Date(Math.min(changeMs + ANALYSIS_WINDOW_DAYS * DAY_MS, Date.now()))
  const postStart = new Date(changeMs)

  if ((postEnd.getTime() - postStart.getTime()) / DAY_MS < MIN_POST_WINDOW_DAYS) return null

  const [pre, post, marketing_spend] = await Promise.all([
    loadConversionWindow(supabase, venueId, preStart, preEnd),
    loadConversionWindow(supabase, venueId, postStart, postEnd),
    loadMarketingSpendChange(supabase, venueId, preStart, preEnd, postStart, postEnd),
  ])

  if (pre.resolved < MIN_PER_WINDOW_RESOLVED) return null
  if (post.resolved < MIN_PER_WINDOW_RESOLVED) return null

  const price_change_pct = ((new_price - old_price) / old_price) * 100
  if (Math.abs(price_change_pct) < 0.5) return null  // <0.5% price change is noise

  // Elasticity. (delta_conversion / pre_conversion) / (delta_price /
  // old_price). Negative = price up → conversion down (expected).
  // Positive = price up → conversion up (premium signal OR confound).
  let elasticity: number | null = null
  if (pre.conversion_rate > 0 && Math.abs(price_change_pct) >= 0.5) {
    const conversion_change_pct = ((post.conversion_rate - pre.conversion_rate) / pre.conversion_rate) * 100
    elasticity = conversion_change_pct / price_change_pct
    elasticity = Math.round(elasticity * 100) / 100
  }

  return {
    venueId,
    changeId: change.id,
    changed_at: change.changed_at,
    old_price,
    new_price,
    price_change_pct: Math.round(price_change_pct * 10) / 10,
    pre,
    post,
    elasticity,
    marketing_spend,
    has_adjacent_change,
    notes: change.notes,
  }
}

/**
 * Pure classification helper — testable in isolation. Picks the
 * elasticity classification given the classical numbers.
 */
export function classifyElasticity(args: {
  elasticity: number | null
  has_adjacent_change: boolean
  marketing_confound: boolean
  pre_n: number
  post_n: number
}): ElasticityClassification {
  // Hard guards.
  if (args.elasticity === null) return 'inconclusive'
  if (args.has_adjacent_change) return 'inconclusive'
  if (args.marketing_confound) {
    // If conversion went the "wrong way" with a marketing-spend
    // confound, the right call is inconclusive. If it went the
    // expected way (negative elasticity), still flag inconclusive
    // because we can't separate the two effects.
    return 'inconclusive'
  }
  if (args.pre_n < MIN_PER_WINDOW_RESOLVED || args.post_n < MIN_PER_WINDOW_RESOLVED) {
    return 'inconclusive'
  }

  if (args.elasticity > 0.1) return 'positive'  // raised price → MORE conversion = premium signal
  if (Math.abs(args.elasticity) < 0.5) return 'inelastic'
  if (Math.abs(args.elasticity) >= 1.0) return 'elastic'
  // Mild negative (-1.0 .. -0.5) — between inelastic and elastic.
  return 'inelastic'
}

async function loadAiName(supabase: SupabaseClient, venueId: string): Promise<string> {
  const { data } = await supabase
    .from('venue_ai_config')
    .select('ai_name')
    .eq('venue_id', venueId)
    .maybeSingle()
  return ((data?.ai_name as string | undefined)?.trim()) || 'your assistant'
}

interface ElasticityDiagnostic {
  classification: ElasticityClassification
  reasoning: string
  recommendation: string
  confidence: number
}

export async function generatePricingElasticity(
  supabase: SupabaseClient,
  venueId: string,
  force: boolean = false,
): Promise<{
  classification: ElasticityClassification
  classification_label: string
  reasoning: string
  recommendation: string
  changeId: string
  changed_at: string
  old_price: number
  new_price: number
  price_change_pct: number
  pre_conversion_pct: number
  post_conversion_pct: number
  pre_n: number
  post_n: number
  elasticity: number | null
  marketing_confound: boolean
  has_adjacent_change: boolean
  confidence: number
  cached: boolean
} | null> {
  const classical = await loadClassicalPricingEvidence(supabase, venueId)
  if (!classical) return null

  const pre_conversion_pct = Math.round(classical.pre.conversion_rate * 1000) / 10
  const post_conversion_pct = Math.round(classical.post.conversion_rate * 1000) / 10
  const marketing_confound = classical.marketing_spend?.is_confound === true

  const cacheKey = buildCacheKey({
    venueId,
    changeId: classical.changeId,
    changedAt: classical.changed_at,
    oldP: classical.old_price,
    newP: classical.new_price,
    preN: classical.pre.resolved,
    postN: classical.post.resolved,
    preConv: pre_conversion_pct,
    postConv: post_conversion_pct,
    elasticity: classical.elasticity,
    confound: marketing_confound,
    adjacent: classical.has_adjacent_change,
  })

  if (!force) {
    const cached = await lookupCachedInsight(
      supabase, venueId, 'pricing_elasticity', classical.changeId, cacheKey,
    )
    if (cached) {
      const dp = cached.data_points as Partial<ClassicalPricingPayload> & {
        classification?: ElasticityClassification
        recommendation?: string
      }
      return {
        classification: dp.classification ?? 'inconclusive',
        classification_label: CLASSIFICATION_LABEL[dp.classification ?? 'inconclusive'],
        reasoning: cached.body,
        recommendation: dp.recommendation ?? cached.action ?? '',
        changeId: classical.changeId,
        changed_at: classical.changed_at,
        old_price: classical.old_price,
        new_price: classical.new_price,
        price_change_pct: classical.price_change_pct,
        pre_conversion_pct,
        post_conversion_pct,
        pre_n: classical.pre.resolved,
        post_n: classical.post.resolved,
        elasticity: classical.elasticity,
        marketing_confound,
        has_adjacent_change: classical.has_adjacent_change,
        confidence: cached.confidence,
        cached: true,
      }
    }
  }

  const aiName = await loadAiName(supabase, venueId)
  const confoundBlock = marketing_confound
    ? `WARNING: Marketing spend changed ${classical.marketing_spend!.delta_pct}% pre→post — treat elasticity as confounded.`
    : (classical.marketing_spend
        ? `Marketing spend stable (${classical.marketing_spend.delta_pct}% delta — within tolerance).`
        : 'No marketing spend data on file for this window.')

  const adjacentBlock = classical.has_adjacent_change
    ? 'WARNING: Another base_price change occurred within ±60 days — windows leak across interventions.'
    : 'Single isolated price change in the window.'

  const systemPrompt = `You are ${aiName}, helping a wedding-venue coordinator
read whether a recent price change moved conversion rates.

Output JSON:
  - classification: 'elastic' | 'inelastic' | 'positive' | 'inconclusive'
    elastic   = |elasticity| >= 1.0 (price-sensitive segment; lift cuts
                conversion proportionately)
    inelastic = |elasticity| < 0.5 (pricing power; conversion barely
                moved)
    positive  = elasticity > 0 (raised price → more conversion;
                premium-positioning signal OR a confound)
    inconclusive = signal too small / confounded / windows too short
  - reasoning: 1 short sentence. Reference the SHAPE of the data (pre vs
    post conversion rates, sample sizes, presence of confound).
  - recommendation: 1 sentence with a SPECIFIC action grounded in the
    classification:
      elastic     → "Walk back X% of the price increase OR pair it with
                    a tour-experience upgrade to justify."
      inelastic   → "You have pricing power; consider testing a further
                    Y% increase next quarter."
      positive    → "Premium-positioning signal — but verify by looking
                    at the marketing spend delta before assuming."
      inconclusive→ "Wait until N more weddings resolve, or annotate the
                    confound and re-run."
  - confidence: 0.0-1.0. Default 0.5. Higher when classification is
    elastic/inelastic with stable marketing + clean window;
    lower when inconclusive.

CRITICAL RULES:
- Numbers in your output must come from the user prompt. The only
  numbers you may use are the price change %, pre/post conversion %,
  pre/post sample sizes, and the elasticity value.
- Never invent dates, weddings, or specific figures.
- If marketing spend confound or adjacent change is flagged, you MUST
  output classification='inconclusive' regardless of elasticity sign.`

  const userPrompt = `PRICING ELASTICITY DIAGNOSTIC

Most-recent base_price change:
  - From $${classical.old_price.toLocaleString()} → $${classical.new_price.toLocaleString()}
  - Price change: ${classical.price_change_pct}%
  - Changed at: ${classical.changed_at.slice(0, 10)}
  - Days since change: ${Math.round((Date.now() - Date.parse(classical.changed_at)) / DAY_MS)}
  - Coordinator notes: ${classical.notes ?? '(none)'}

Pre-change window (${ANALYSIS_WINDOW_DAYS} days before):
  - Resolved weddings (booked + lost): ${classical.pre.resolved}
  - Conversion rate: ${pre_conversion_pct}%

Post-change window (${ANALYSIS_WINDOW_DAYS} days after, capped at today):
  - Resolved weddings: ${classical.post.resolved}
  - Conversion rate: ${post_conversion_pct}%

Elasticity: ${classical.elasticity ?? 'unable to compute'}

Confound checks:
  - ${confoundBlock}
  - ${adjacentBlock}

Diagnose + recommend.`

  let result: ElasticityDiagnostic | null = null
  try {
    const raw = await callAIJson<ElasticityDiagnostic>({
      systemPrompt,
      userPrompt,
      maxTokens: 320,
      temperature: 0.3,
      venueId,
      taskType: 'pricing_elasticity',
      tier: 'sonnet',
      promptVersion: PRICING_ELASTICITY_PROMPT_VERSION,
    })
    if (raw && CLASSIFICATION_LABEL[raw.classification as ElasticityClassification]) {
      result = {
        classification: raw.classification as ElasticityClassification,
        reasoning: (raw.reasoning ?? '').trim() || 'Classification derived from elasticity calculation.',
        recommendation: (raw.recommendation ?? '').trim() || 'Watch the next 30 days of conversions before acting.',
        confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      }
    }
  } catch (err) {
    console.warn('[pricing-elasticity] LLM diagnostic failed:', err instanceof Error ? err.message : err)
  }

  // Deterministic fallback when LLM unavailable. Uses pure classifier.
  if (!result) {
    const classification = classifyElasticity({
      elasticity: classical.elasticity,
      has_adjacent_change: classical.has_adjacent_change,
      marketing_confound,
      pre_n: classical.pre.resolved,
      post_n: classical.post.resolved,
    })
    const recommendation = classification === 'elastic'
      ? 'Conversion fell proportionally with the price increase; consider walking back part of it or pairing with a tour-experience upgrade.'
      : classification === 'inelastic'
      ? 'Conversion barely moved — pricing power confirmed; consider testing a further increase next quarter.'
      : classification === 'positive'
      ? 'Higher price coincided with higher conversion — premium signal OR confound; verify marketing spend before acting.'
      : 'Signal too small or confounded; wait for more resolved weddings or annotate the confound.'
    result = {
      classification,
      reasoning: 'Classification inferred deterministically (LLM diagnostic unavailable).',
      recommendation,
      confidence: 0.4,
    }
  }

  // ENFORCE the rule: confound or adjacent change => inconclusive.
  // Even if the LLM said "elastic", we override. The narration above
  // already tells the LLM to do this; this is the belt for the
  // suspenders.
  if ((marketing_confound || classical.has_adjacent_change) && result.classification !== 'inconclusive') {
    result = { ...result, classification: 'inconclusive', confidence: Math.min(result.confidence, 0.4) }
  }

  // Numbers the narration may reference. Include both signed and abs
  // forms so the LLM saying "1.2x elasticity" matches the abs(-1.2).
  const allowedNumbers: Array<number | string> = [
    classical.price_change_pct,
    Math.abs(classical.price_change_pct),
    pre_conversion_pct,
    post_conversion_pct,
    classical.pre.resolved,
    classical.post.resolved,
    classical.elasticity ?? 0,
    classical.elasticity !== null ? Math.abs(classical.elasticity) : 0,
    classical.old_price,
    classical.new_price,
    classical.marketing_spend?.delta_pct ?? 0,
  ]

  const evidence: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: {
      ...classical,
      classification: result.classification,
      reasoning: result.reasoning,
      recommendation: result.recommendation,
      llm_confidence: result.confidence,
    } as unknown as Record<string, unknown>,
    sampleSize: classical.pre.resolved + classical.post.resolved,
    // Effect = how clean the elasticity signal is.
    // |elasticity| close to 0 OR confound present → low effect.
    // Strong elastic OR strong inelastic + no confound → high.
    effectSize: (() => {
      if (marketing_confound || classical.has_adjacent_change) return 0.2
      if (classical.elasticity === null) return 0.2
      const e = Math.abs(classical.elasticity)
      // 1.0 elasticity → effect 1.0; 0 elasticity → effect 0.5
      // (no movement is itself a signal of inelasticity).
      return Math.min(1, 0.5 + e * 0.5)
    })(),
  }
  const conf = confidenceFor({
    sampleSize: evidence.sampleSize,
    effectSize: evidence.effectSize,
  })

  const narration: InsightNarration = {
    title: result.classification === 'elastic'
      ? `Pricing elasticity: conversion fell ${Math.abs(post_conversion_pct - pre_conversion_pct).toFixed(1)}pp`
      : result.classification === 'inelastic'
      ? `Pricing power confirmed (${classical.price_change_pct}% price change)`
      : result.classification === 'positive'
      ? 'Premium positioning signal'
      : 'Pricing change: signal inconclusive',
    body: result.reasoning,
    action: result.recommendation,
  }

  await persistInsight(supabase, {
    venueId,
    insightType: 'pricing_elasticity',
    contextId: classical.changeId,
    category: 'pricing',
    surfaceLayer: result.classification === 'elastic' ? 'pulse' : 'on_demand',
    classical: evidence,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: PRICING_ELASTICITY_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: Math.abs(classical.elasticity ?? 0) * 100 + classical.pre.resolved + classical.post.resolved,
    priority: result.classification === 'elastic' ? 'high'
      : result.classification === 'positive' ? 'medium'
      : result.classification === 'inelastic' ? 'medium'
      : 'low',
  })

  return {
    classification: result.classification,
    classification_label: CLASSIFICATION_LABEL[result.classification],
    reasoning: result.reasoning,
    recommendation: result.recommendation,
    changeId: classical.changeId,
    changed_at: classical.changed_at,
    old_price: classical.old_price,
    new_price: classical.new_price,
    price_change_pct: classical.price_change_pct,
    pre_conversion_pct,
    post_conversion_pct,
    pre_n: classical.pre.resolved,
    post_n: classical.post.resolved,
    elasticity: classical.elasticity,
    marketing_confound,
    has_adjacent_change: classical.has_adjacent_change,
    confidence: conf.value,
    cached: false,
  }
}

// Re-exports for unit tests — pure helpers.
export const __test__ = {
  classifyElasticity,
  CLASSIFICATION_LABEL,
  ANALYSIS_WINDOW_DAYS,
  MIN_POST_WINDOW_DAYS,
  MIN_DAYS_SINCE_CHANGE,
  ADJACENT_CHANGE_GAP_DAYS,
  MIN_PER_WINDOW_RESOLVED,
  MARKETING_CONFOUND_THRESHOLD_PCT,
}
