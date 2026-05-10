/**
 * Bloom House — Wave 7A pattern discovery engine service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 7 closes the forensic loop: hunt for
 *     unknown-unknowns. THE differentiator vs every other CRM. Other
 *     wedding CRMs tell you what you already know — Wave 7 tells you
 *     what you don't).
 *   - bloom-wave4-5-6-master-plan.md (Wave 7A spec — discovery engine,
 *     free-form output, the LLM invents the hypothesis category).
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose — the engine
 *     sees ANONYMISED rollups only, never names couples).
 *   - bloom-may9-llm-vs-template.md (the engine is a real Sonnet call,
 *     never a template).
 *   - feedback_parallel_stream_safety.md (Wave 7A is on migration 267;
 *     does NOT modify reconstruct.ts, per-couple-derive.ts, or any
 *     shared file outside its own directory).
 *
 * What this service does
 * ----------------------
 * For one venue, load anonymised cohort context (persona distribution,
 * persona × close-probability medians, channel × role aggregates,
 * conversion-by-bucket, venue_intel rollup summary, recent intel_matches,
 * inquiry time-of-day distribution), then call Sonnet with the discovery
 * prompt. Parse + validate the output. Insert each hypothesis as a NEW
 * row in intel_discoveries (preserves audit history; near-duplicate
 * dedupe is a follow-up, not blocking).
 *
 * Different LLM job from Wave 5/6
 * -------------------------------
 * Wave 5/6 are CLASSIFIERS — they fill pre-defined buckets. Wave 7A is
 * a DISCOVERY engine. The hypothesis_category is FREE-FORM by design —
 * if the LLM finds a brand-new pattern type that fits no existing bucket,
 * it should invent a new category. That's the whole point.
 *
 * Cost target ~$0.10-0.30 per venue per run (one Sonnet call with ~3-5k
 * input tokens of anonymised cohort context, ~1-3k output tokens of
 * structured discoveries).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  DISCOVERY_ENGINE_PROMPT_VERSION,
  buildDiscoveryEngineSystemPrompt,
  buildDiscoveryEngineUserPrompt,
  validateDiscoveryEngineOutput,
  type Discovery,
  type DiscoveryEvidence,
  type CohortPersonaShare,
  type PersonaCloseProbabilityStat,
  type ChannelRoleShare,
  type CohortConversionStat,
  type RecentMatchSummary,
  type VenueIntelRollupSummary,
  type CohortThemeShare,
} from '@/config/prompts/discovery-engine'

// Re-export so callers don't have to import from two places.
export {
  DISCOVERY_ENGINE_PROMPT_VERSION,
  type Discovery,
} from '@/config/prompts/discovery-engine'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunDiscoveryEngineOptions {
  /** Optional client override (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** Trailing window for cohort considered. Default 90. */
  windowDays?: number
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
}

export interface RunDiscoveryEngineResult {
  discoveries: Discovery[]
  refusals: Array<{ field: string; reason: string }>
  costCents: number
  promptVersion: string
  inserted: number
  skipped: number
}

export interface RunDiscoveryEngineInput {
  venueId: string
  /** Force run even if cohort is empty (for tests / manual debugging). */
  force?: boolean
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 90
const MAX_INPUT_LOAD_PROFILES = 500
const MAX_INTEL_MATCHES_LOAD = 60
const COHORT_FLOOR_FOR_DISCOVERY = 5
const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Loaders — every loader returns ANONYMISED aggregates only.
// ---------------------------------------------------------------------------

interface VenueRow {
  id: string
  name: string | null
  state: string | null
}

async function loadVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueRow | null> {
  const { data } = await supabase
    .from('venues')
    .select('id, name, state')
    .eq('id', venueId)
    .maybeSingle()
  return (data as VenueRow | null) ?? null
}

interface CoupleIntelRow {
  wedding_id: string
  venue_id: string
  persona_label: string | null
  predicted_close_probability_pct: number | null
  last_derived_at: string
}

async function loadCoupleIntel(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<CoupleIntelRow[]> {
  const { data, error } = await supabase
    .from('couple_intel')
    .select(
      'wedding_id, venue_id, persona_label, predicted_close_probability_pct, last_derived_at',
    )
    .eq('venue_id', venueId)
    .gte('last_derived_at', windowStartIso)
    .limit(MAX_INPUT_LOAD_PROFILES)
  if (error) {
    console.warn('[discovery-engine] loadCoupleIntel failed:', error.message)
    return []
  }
  return (data ?? []) as CoupleIntelRow[]
}

function buildPersonaDistribution(
  rows: CoupleIntelRow[],
): CohortPersonaShare[] {
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (!r.persona_label) continue
    counts.set(r.persona_label, (counts.get(r.persona_label) ?? 0) + 1)
  }
  if (counts.size === 0) return []
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  const out: CohortPersonaShare[] = []
  for (const [label, n] of counts.entries()) {
    out.push({
      persona_label: label,
      share_pct: total === 0 ? 0 : Math.round((n / total) * 100),
      n_couples: n,
    })
  }
  out.sort((a, b) => b.share_pct - a.share_pct)
  return out
}

function buildPersonaCloseProbabilities(
  rows: CoupleIntelRow[],
): PersonaCloseProbabilityStat[] {
  const byPersona = new Map<string, number[]>()
  for (const r of rows) {
    if (!r.persona_label) continue
    const v = r.predicted_close_probability_pct
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    const arr = byPersona.get(r.persona_label) ?? []
    arr.push(v)
    byPersona.set(r.persona_label, arr)
  }
  const out: PersonaCloseProbabilityStat[] = []
  for (const [label, vals] of byPersona.entries()) {
    if (vals.length === 0) continue
    vals.sort((a, b) => a - b)
    const median =
      vals.length % 2 === 1
        ? vals[Math.floor(vals.length / 2)]
        : Math.round((vals[vals.length / 2 - 1] + vals[vals.length / 2]) / 2)
    out.push({
      persona_label: label,
      n_couples: vals.length,
      median_close_probability_0_100: median,
    })
  }
  out.sort((a, b) => b.n_couples - a.n_couples)
  return out
}

interface AttributionRow {
  wedding_id: string
  source_platform: string
  role: string | null
  persona_overlay: { persona_label?: string } | null
  decided_at: string
}

async function loadAttributionEvents(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<AttributionRow[]> {
  const { data, error } = await supabase
    .from('attribution_events')
    .select(
      'wedding_id, source_platform, role, persona_overlay, decided_at',
    )
    .eq('venue_id', venueId)
    .is('reverted_at', null)
    .gte('decided_at', windowStartIso)
    .limit(2000)
  if (error) {
    console.warn(
      '[discovery-engine] loadAttributionEvents failed:',
      error.message,
    )
    return []
  }
  return (data ?? []) as AttributionRow[]
}

function normalisePlatform(raw: string): string {
  if (!raw) return 'other'
  const lower = raw.trim().toLowerCase()
  if (lower === 'theknot' || lower === 'the_knot') return 'theknot'
  if (lower === 'instagram' || lower === 'facebook' || lower === 'meta') {
    return 'meta'
  }
  if (lower === 'tiktok') return 'tiktok'
  if (lower === 'google' || lower === 'google_search') return 'google'
  if (lower === 'weddingwire') return 'weddingwire'
  return lower
}

function buildChannelRoleShares(
  rows: AttributionRow[],
): ChannelRoleShare[] {
  const byPlatform = new Map<string, ChannelRoleShare>()
  for (const r of rows) {
    const platform = normalisePlatform(r.source_platform)
    let acc = byPlatform.get(platform)
    if (!acc) {
      acc = {
        source_platform: platform,
        acquisition_count: 0,
        validation_count: 0,
        conversion_count: 0,
        unknown_count: 0,
      }
      byPlatform.set(platform, acc)
    }
    const role = (r.role ?? 'unknown').toLowerCase()
    if (role === 'acquisition') acc.acquisition_count += 1
    else if (role === 'validation') acc.validation_count += 1
    else if (role === 'conversion') acc.conversion_count += 1
    else acc.unknown_count += 1
  }
  const out = Array.from(byPlatform.values())
  out.sort((a, b) => {
    const ta =
      a.acquisition_count +
      a.validation_count +
      a.conversion_count +
      a.unknown_count
    const tb =
      b.acquisition_count +
      b.validation_count +
      b.conversion_count +
      b.unknown_count
    return tb - ta
  })
  return out
}

interface WeddingRow {
  id: string
  venue_id: string
  status: string | null
  inquiry_date: string | null
  booked_at: string | null
  lost_at: string | null
}

async function loadWeddingsForVenue(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<WeddingRow[]> {
  // Pull weddings whose inquiry_date OR booked_at OR lost_at fell in the
  // window — discovery wants both inquiries and outcomes inside the
  // window. Postgres OR via PostgREST is verbose; we just over-fetch on
  // inquiry_date and let the JS layer filter what we don't use.
  const { data, error } = await supabase
    .from('weddings')
    .select('id, venue_id, status, inquiry_date, booked_at, lost_at')
    .eq('venue_id', venueId)
    .gte('inquiry_date', windowStartIso)
    .limit(2000)
  if (error) {
    console.warn(
      '[discovery-engine] loadWeddingsForVenue failed:',
      error.message,
    )
    return []
  }
  return (data ?? []) as WeddingRow[]
}

function buildConversionByBucket(
  attributions: AttributionRow[],
  weddings: Map<string, WeddingRow>,
  intelByWedding: Map<string, CoupleIntelRow>,
): CohortConversionStat[] {
  // Bucket = "platform | persona" so the LLM can spot disparities within
  // a channel by persona slice. Skip buckets with < 5 inquiries —
  // anything smaller is noise.
  interface BucketAcc {
    n_inquiries: number
    n_booked: number
    closeProbs: number[]
  }
  const byBucket = new Map<string, BucketAcc>()
  for (const a of attributions) {
    const platform = normalisePlatform(a.source_platform)
    const persona =
      a.persona_overlay?.persona_label?.trim() ||
      intelByWedding.get(a.wedding_id)?.persona_label?.trim() ||
      'unknown_persona'
    const key = `${platform} | ${persona}`
    let acc = byBucket.get(key)
    if (!acc) {
      acc = { n_inquiries: 0, n_booked: 0, closeProbs: [] }
      byBucket.set(key, acc)
    }
    acc.n_inquiries += 1
    const w = weddings.get(a.wedding_id)
    if (w) {
      const status = (w.status ?? '').toLowerCase()
      if (status === 'booked' || status === 'completed') acc.n_booked += 1
    }
    const intel = intelByWedding.get(a.wedding_id)
    if (intel?.predicted_close_probability_pct != null) {
      acc.closeProbs.push(intel.predicted_close_probability_pct)
    }
  }
  const out: CohortConversionStat[] = []
  for (const [bucket, acc] of byBucket.entries()) {
    if (acc.n_inquiries < 5) continue
    const conversion =
      acc.n_inquiries === 0
        ? 0
        : Math.round((acc.n_booked / acc.n_inquiries) * 1000) / 10
    let median: number | null = null
    if (acc.closeProbs.length > 0) {
      const sorted = acc.closeProbs.slice().sort((a, b) => a - b)
      median =
        sorted.length % 2 === 1
          ? sorted[Math.floor(sorted.length / 2)]
          : Math.round(
              (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2,
            )
    }
    out.push({
      bucket,
      n_inquiries: acc.n_inquiries,
      n_booked: acc.n_booked,
      conversion_pct: conversion,
      median_close_probability_0_100: median,
    })
  }
  out.sort((a, b) => b.n_inquiries - a.n_inquiries)
  return out.slice(0, 30)
}

interface VenueIntelRow {
  rollup: {
    emerging_themes?: Array<{
      theme: string
      trend?: string
      evidence_count?: number
      sensitivity_filtered_count?: number
    }>
    conversion_correlations?: Array<{
      signal?: string
      outcome?: string
      lift_pct?: number
      confidence_0_100?: number
    }>
    service_demand_map?: Array<{
      service_or_offering?: string
      demand_signal?: string
    }>
    timing_patterns?: Array<{
      pattern?: string
      actionable_recommendation?: string
    }>
  }
  couples_in_window: number
}

async function loadVenueIntel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueIntelRow | null> {
  const { data } = await supabase
    .from('venue_intel')
    .select('rollup, couples_in_window')
    .eq('venue_id', venueId)
    .maybeSingle()
  return (data as VenueIntelRow | null) ?? null
}

function buildVenueIntelRollupSummary(
  row: VenueIntelRow | null,
): { summary: VenueIntelRollupSummary | null; sensitivePresent: boolean } {
  if (!row || !row.rollup) return { summary: null, sensitivePresent: false }
  const r = row.rollup
  let sensitivePresent = false

  const emergingThemes: CohortThemeShare[] = []
  for (const t of r.emerging_themes ?? []) {
    if (!t || !t.theme) continue
    const sens = (t.sensitivity_filtered_count ?? 0) > 0
    if (sens) {
      sensitivePresent = true
      // Per aggregate ≠ disclose: surface the theme label + count, never
      // include the underlying evidence quotes. Wave 5B's rollup already
      // strips quotes; we just don't propagate sensitive themes whose
      // evidence_count is zero (they were entirely sensitive-filtered).
      if ((t.evidence_count ?? 0) === 0) continue
    }
    const trendRaw = (t.trend ?? 'unknown').toLowerCase()
    const trend: CohortThemeShare['trend'] =
      trendRaw === 'rising' || trendRaw === 'declining' || trendRaw === 'steady'
        ? trendRaw
        : 'unknown'
    emergingThemes.push({
      theme: t.theme,
      share_pct: 0, // Wave 5B doesn't expose share_pct directly.
      trend,
      evidence_count: t.evidence_count ?? 0,
    })
  }

  const conversionCorrelations: Array<{
    signal: string
    trend: string
    lift: string
  }> = []
  for (const c of r.conversion_correlations ?? []) {
    if (!c || !c.signal) continue
    const liftDisplay =
      typeof c.lift_pct === 'number' ? `${c.lift_pct}%` : 'unknown'
    conversionCorrelations.push({
      signal: c.signal,
      trend: c.outcome ?? 'unknown',
      lift: liftDisplay,
    })
  }

  const serviceDemandTop: Array<{ service: string; share_pct: number }> = []
  for (const s of (r.service_demand_map ?? []).slice(0, 5)) {
    if (!s || !s.service_or_offering) continue
    serviceDemandTop.push({
      service: s.service_or_offering,
      share_pct: 0,
    })
  }

  const timingPatternsTop: string[] = []
  for (const p of (r.timing_patterns ?? []).slice(0, 5)) {
    if (!p || !p.pattern) continue
    timingPatternsTop.push(p.pattern)
  }

  const summary: VenueIntelRollupSummary = {
    emerging_themes: emergingThemes.slice(0, 10),
    conversion_correlations: conversionCorrelations.slice(0, 10),
    service_demand_top: serviceDemandTop,
    timing_patterns_top: timingPatternsTop,
  }

  return { summary, sensitivePresent }
}

interface IntelMatchRow {
  signal_type: string
  signal_payload: Record<string, unknown>
  match_confidence_0_100: number
  cohort_fit_score_0_100: number | null
  fired_at: string
}

async function loadRecentIntelMatches(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<IntelMatchRow[]> {
  const { data, error } = await supabase
    .from('intel_matches')
    .select(
      'signal_type, signal_payload, match_confidence_0_100, cohort_fit_score_0_100, fired_at',
    )
    .eq('venue_id', venueId)
    .gte('fired_at', windowStartIso)
    .is('dismissed_at', null)
    .order('fired_at', { ascending: false })
    .limit(MAX_INTEL_MATCHES_LOAD)
  if (error) {
    console.warn(
      '[discovery-engine] loadRecentIntelMatches failed:',
      error.message,
    )
    return []
  }
  return (data ?? []) as IntelMatchRow[]
}

function summariseIntelMatch(row: IntelMatchRow): RecentMatchSummary {
  let summary = row.signal_type
  const p = row.signal_payload ?? {}
  if (row.signal_type === 'cultural_moment') {
    summary = `Cultural moment: ${String(p.title ?? 'unknown')}`
  } else if (row.signal_type === 'vendor_mention') {
    const name = String(p.vendor_name ?? 'unknown vendor')
    const n = Number(p.distinct_couples ?? 0)
    summary = `Vendor mention: ${name} (${n} couples)`
  } else if (row.signal_type === 'competitor_mention') {
    const name = String(p.competitor_name ?? 'unknown competitor')
    const n = Number(p.mention_count ?? 0)
    summary = `Competitor mention: ${name} (${n} mentions)`
  } else if (row.signal_type === 'regional_benchmark') {
    summary = `Regional benchmark: persona dist vs cross-venue average`
  } else if (row.signal_type === 'cross_platform_handle') {
    summary = `Cross-platform handle: ${String(p.platform ?? 'unknown')}`
  }
  return {
    signal_type: row.signal_type,
    summary,
    match_confidence_0_100: row.match_confidence_0_100,
    cohort_fit_score_0_100: row.cohort_fit_score_0_100,
  }
}

interface InteractionTimeRow {
  timestamp: string | null
}

async function loadInquiryTimestamps(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<InteractionTimeRow[]> {
  const { data, error } = await supabase
    .from('interactions')
    .select('timestamp')
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .gte('timestamp', windowStartIso)
    .limit(2000)
  if (error) {
    console.warn(
      '[discovery-engine] loadInquiryTimestamps failed:',
      error.message,
    )
    return []
  }
  return (data ?? []) as InteractionTimeRow[]
}

function bucketTimeOfDay(
  rows: InteractionTimeRow[],
): Array<{ bucket: string; n_inquiries: number }> {
  // Buckets: 00-06 (overnight), 06-09 (early morning), 09-12 (morning),
  // 12-17 (afternoon), 17-20 (evening), 20-24 (late evening). All in
  // the venue's local timezone; we approximate with UTC since per-venue
  // timezone isn't part of the cohort summary input. Operator can refine
  // by adding venue_id-localised bucketing in a follow-up.
  const buckets = new Map<string, number>()
  const labels = [
    '00-06 overnight',
    '06-09 early morning',
    '09-12 morning',
    '12-17 afternoon',
    '17-20 evening',
    '20-24 late evening',
  ]
  for (const row of rows) {
    if (!row.timestamp) continue
    const t = new Date(row.timestamp)
    if (Number.isNaN(t.getTime())) continue
    const h = t.getUTCHours()
    let bucket: string
    if (h < 6) bucket = labels[0]
    else if (h < 9) bucket = labels[1]
    else if (h < 12) bucket = labels[2]
    else if (h < 17) bucket = labels[3]
    else if (h < 20) bucket = labels[4]
    else bucket = labels[5]
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1)
  }
  const out: Array<{ bucket: string; n_inquiries: number }> = []
  for (const label of labels) {
    out.push({ bucket: label, n_inquiries: buckets.get(label) ?? 0 })
  }
  return out
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runDiscoveryEngine(
  input: RunDiscoveryEngineInput,
  options: RunDiscoveryEngineOptions = {},
): Promise<RunDiscoveryEngineResult> {
  const supabase = options.supabase ?? createServiceClient()
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const correlationId = options.correlationId
  const force = input.force === true

  const venueId = input.venueId
  if (!venueId) {
    throw new Error('runDiscoveryEngine: venueId required')
  }

  const windowStartIso = new Date(
    Date.now() - windowDays * DAY_MS,
  ).toISOString()

  // 1. Resolve venue.
  const venue = await loadVenue(supabase, venueId)
  if (!venue) {
    throw new Error(`runDiscoveryEngine: venue ${venueId} not found`)
  }

  // 2. Load all evidence sources in parallel. Each loader returns
  // anonymised aggregates only — no raw bodies, no couple names.
  const [
    coupleIntelRows,
    attributions,
    weddings,
    venueIntel,
    intelMatches,
    inquiryTimestamps,
  ] = await Promise.all([
    loadCoupleIntel(supabase, venueId, windowStartIso),
    loadAttributionEvents(supabase, venueId, windowStartIso),
    loadWeddingsForVenue(supabase, venueId, windowStartIso),
    loadVenueIntel(supabase, venueId),
    loadRecentIntelMatches(supabase, venueId, windowStartIso),
    loadInquiryTimestamps(supabase, venueId, windowStartIso),
  ])

  const intelByWedding = new Map<string, CoupleIntelRow>()
  for (const r of coupleIntelRows) intelByWedding.set(r.wedding_id, r)

  const weddingsById = new Map<string, WeddingRow>()
  for (const w of weddings) weddingsById.set(w.id, w)

  const personaDistribution = buildPersonaDistribution(coupleIntelRows)
  const personaCloseProbabilities =
    buildPersonaCloseProbabilities(coupleIntelRows)
  const channelRoleShares = buildChannelRoleShares(attributions)
  const conversionByBucket = buildConversionByBucket(
    attributions,
    weddingsById,
    intelByWedding,
  )
  const { summary: venueIntelRollup, sensitivePresent } =
    buildVenueIntelRollupSummary(venueIntel)
  const recentMatches = intelMatches.map(summariseIntelMatch)
  const timeOfDayCounts = bucketTimeOfDay(inquiryTimestamps)

  // Cohort floor: with truly empty data, the LLM has nothing to discover.
  // We still call when force=true (manual debug) but otherwise return a
  // refusal up-front.
  const totalCouplesInCohort = Math.max(
    coupleIntelRows.length,
    venueIntel?.couples_in_window ?? 0,
  )
  if (
    !force &&
    totalCouplesInCohort < COHORT_FLOOR_FOR_DISCOVERY &&
    weddings.length < COHORT_FLOOR_FOR_DISCOVERY
  ) {
    return {
      discoveries: [],
      refusals: [
        {
          field: 'discoveries',
          reason: `cohort too small to ground discovery (couples_in_cohort=${totalCouplesInCohort}, weddings_in_window=${weddings.length}; floor=${COHORT_FLOOR_FOR_DISCOVERY})`,
        },
      ],
      costCents: 0,
      promptVersion: DISCOVERY_ENGINE_PROMPT_VERSION,
      inserted: 0,
      skipped: 0,
    }
  }

  const evidence: DiscoveryEvidence = {
    venueId,
    venueLabel: venue.name,
    venueState: venue.state,
    windowDays,
    totalCouplesInCohort,
    personaDistribution,
    personaCloseProbabilities,
    channelRoleShares,
    conversionByBucket,
    venueIntelRollup,
    recentMatches,
    timeOfDayCounts,
    sensitiveThemesPresent: sensitivePresent,
  }

  const systemPrompt = buildDiscoveryEngineSystemPrompt()
  const userPrompt = buildDiscoveryEngineUserPrompt(evidence)

  // Sonnet call — temperature 0.5 (higher than Wave 5/6 because discovery
  // favours creative pattern-finding over deterministic classification).
  // contentTier 2 — anonymised cohort summaries only, no raw quotes; the
  // tag is conservative (default tier) since some persona labels could
  // theoretically include cohort-identifying phrasing.
  // maxTokens 4000 — caps output at 5 discoveries × ~600 tokens each plus
  // refusals, fits comfortably under the 30s callAI timeout. The prompt
  // already enforces the 5-discovery cap, so we don't need 6000 of
  // headroom and the smaller cap meaningfully reduces cold-start latency.
  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'discovery_engine',
    contentTier: 2,
    promptVersion: DISCOVERY_ENGINE_PROMPT_VERSION,
    venueId,
    maxTokens: 4000,
    temperature: 0.5,
    correlationId,
  })

  // Parse + validate.
  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message =
      parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `runDiscoveryEngine: LLM returned non-JSON. parseError=${message} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const validation = validateDiscoveryEngineOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `runDiscoveryEngine: schema validation failed. error=${validation.error} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const output = validation.output

  const newCallCostCents = aiResult.cost * 100

  // Insert each discovery as a NEW row. New runs preserve audit history;
  // a follow-up dedupe pass may merge near-duplicate titles within a
  // recent window — that's a Wave 7A follow-up, not blocking.
  let inserted = 0
  let skipped = 0
  for (const d of output.discoveries) {
    try {
      const { error: insertErr } = await supabase
        .from('intel_discoveries')
        .insert({
          venue_id: venueId,
          hypothesis_title: d.hypothesis_title,
          hypothesis_text: d.hypothesis_text,
          hypothesis_category: d.hypothesis_category,
          evidence_summary: d.evidence_summary,
          recommended_test: d.recommended_test,
          recommended_action_if_validated: d.recommended_action_if_validated,
          confidence_0_100: d.confidence_0_100,
          validation_status: 'pending',
          prompt_version: DISCOVERY_ENGINE_PROMPT_VERSION,
          // Cost is split evenly across discoveries — single-call total
          // divided by N — so the per-row audit shows what each discovery
          // cost in aggregate. Zero-discovery refusals don't get a row,
          // so the total still nets to the API cost.
          cost_cents:
            output.discoveries.length === 0
              ? 0
              : newCallCostCents / output.discoveries.length,
        })
      if (insertErr) {
        console.warn(
          '[discovery-engine] insert failed:',
          insertErr.message,
        )
        skipped += 1
      } else {
        inserted += 1
      }
    } catch (err) {
      console.warn(
        '[discovery-engine] insert threw:',
        err instanceof Error ? err.message : err,
      )
      skipped += 1
    }
  }

  return {
    discoveries: output.discoveries,
    refusals: output.refusals,
    costCents: newCallCostCents,
    promptVersion: DISCOVERY_ENGINE_PROMPT_VERSION,
    inserted,
    skipped,
  }
}

// ---------------------------------------------------------------------------
// Read / triage helpers — used by the dashboard endpoints.
// ---------------------------------------------------------------------------

export interface StoredDiscoveryRow {
  id: string
  venue_id: string
  hypothesis_title: string
  hypothesis_text: string
  hypothesis_category: string
  evidence_summary: Record<string, unknown>
  recommended_test: string | null
  recommended_action_if_validated: string | null
  confidence_0_100: number
  validation_status: string
  validation_result_summary: string | null
  validation_metric: Record<string, unknown> | null
  validated_at: string | null
  dismissed_at: string | null
  dismissed_by: string | null
  dismissal_reason: string | null
  actioned_at: string | null
  action_taken: string | null
  prompt_version: string
  cost_cents: number
  created_at: string
  updated_at: string
}

export interface ListDiscoveriesOptions {
  status?: string
  category?: string
  limit?: number
}

export async function listDiscoveries(
  venueId: string,
  options: ListDiscoveriesOptions = {},
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredDiscoveryRow[]> {
  const limit = Math.min(options.limit ?? 100, 500)
  let query = supabase
    .from('intel_discoveries')
    .select(
      'id, venue_id, hypothesis_title, hypothesis_text, hypothesis_category, evidence_summary, recommended_test, recommended_action_if_validated, confidence_0_100, validation_status, validation_result_summary, validation_metric, validated_at, dismissed_at, dismissed_by, dismissal_reason, actioned_at, action_taken, prompt_version, cost_cents, created_at, updated_at',
    )
    .eq('venue_id', venueId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (options.status) query = query.eq('validation_status', options.status)
  if (options.category) query = query.eq('hypothesis_category', options.category)

  const { data, error } = await query
  if (error) {
    throw new Error(`listDiscoveries: ${error.message}`)
  }
  return (data ?? []) as StoredDiscoveryRow[]
}

export async function getDiscovery(
  discoveryId: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredDiscoveryRow | null> {
  const { data, error } = await supabase
    .from('intel_discoveries')
    .select(
      'id, venue_id, hypothesis_title, hypothesis_text, hypothesis_category, evidence_summary, recommended_test, recommended_action_if_validated, confidence_0_100, validation_status, validation_result_summary, validation_metric, validated_at, dismissed_at, dismissed_by, dismissal_reason, actioned_at, action_taken, prompt_version, cost_cents, created_at, updated_at',
    )
    .eq('id', discoveryId)
    .maybeSingle()
  if (error) {
    throw new Error(`getDiscovery: ${error.message}`)
  }
  return (data as StoredDiscoveryRow | null) ?? null
}

export async function dismissDiscovery(
  discoveryId: string,
  reason: string | null,
  userId: string | null,
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const { error } = await supabase
    .from('intel_discoveries')
    .update({
      validation_status: 'dismissed',
      dismissed_at: new Date().toISOString(),
      dismissed_by: userId,
      dismissal_reason: reason,
    })
    .eq('id', discoveryId)
  if (error) {
    throw new Error(`dismissDiscovery: ${error.message}`)
  }
}

export async function actionDiscovery(
  discoveryId: string,
  actionTaken: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const { error } = await supabase
    .from('intel_discoveries')
    .update({
      actioned_at: new Date().toISOString(),
      action_taken: actionTaken,
    })
    .eq('id', discoveryId)
  if (error) {
    throw new Error(`actionDiscovery: ${error.message}`)
  }
}
