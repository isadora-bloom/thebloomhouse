/**
 * Wave 6C — marketing reallocation recommendations service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 6 closes the forensic loop. Wave 6B
 *     produces the rollup; Wave 6C turns it into actionable reallocation
 *     recommendations the operator audits and decides on.)
 *   - bloom-wave4-5-6-master-plan.md (6C: Sonnet recommendation job
 *     reads (rollups + cohort intel + external signals) and outputs 3-5
 *     specific reallocation recommendations with reasoning chain +
 *     confidence + counterfactual.)
 *   - feedback_parallel_stream_safety.md (Wave 6C reads from
 *     persona_channel_rollups (Wave 6B) + intel_matches (Wave 5C) +
 *     attribution_events (Wave 7B). All read-only.)
 *
 * What this module does
 * ---------------------
 * For one venue:
 *   1. Snapshot the latest persona_channel_rollups (latest computed_at,
 *      90-day window).
 *   2. Snapshot couple_intel persona shares + venue_intel rollup themes.
 *   3. Snapshot recent intel_matches (Wave 5C external signals).
 *   4. Snapshot attribution_events role distribution (Wave 7B).
 *   5. Hash the input. If the same hash already produced
 *      recommendations within the last 7 days, short-circuit (last
 *      week's rec stands).
 *   6. Otherwise call Sonnet, validate, and INSERT each recommendation
 *      as a new row (preserves history).
 *
 * Idempotent
 * ----------
 * The input hash short-circuits same-data re-runs. Re-running with
 * changed data inserts new recommendations; old ones stay (audit
 * trail). The dashboard groups by status so the operator only sees
 * pending recs by default.
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
  buildMarketingRecommendationsSystemPrompt,
  buildMarketingRecommendationsUserPrompt,
  validateMarketingRecommendationsOutput,
  type MarketingRecommendationsEvidence,
  type MarketingRecommendation,
  type RecommendationRefusal,
  type RollupCellEvidence,
  type CohortPersonaShareEvidence,
  type CohortThemeShareEvidence,
  type ExternalSignalSummaryEvidence,
  type AttributionRoleSummaryEvidence,
} from '@/config/prompts/marketing-recommendations'
import type { CohortRollupOutput } from '@/config/prompts/cohort-rollup'

export {
  MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
  type MarketingRecommendation,
  type RecommendationRefusal,
} from '@/config/prompts/marketing-recommendations'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GenerateMarketingRecommendationsOptions {
  supabase?: SupabaseClient
  /** Trailing window for cohort considered. Default 90. */
  windowDays?: number
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
  /** When true, bypass the input-hash short-circuit and re-run Sonnet
   *  even if the input hasn't changed. Used by the manual "Generate now"
   *  button. */
  force?: boolean
}

export interface GenerateMarketingRecommendationsResult {
  ok: true
  venueId: string
  /** Recommendations written this run. Empty when short-circuited. */
  recommendations: MarketingRecommendation[]
  refusals: RecommendationRefusal[]
  /** Number of rows inserted into marketing_recommendations. */
  inserted: number
  /** Total cost in cents for this generation pass. */
  costCents: number
  /** Hash of the input data. Stored on each generated row. */
  idempotencyHash: string
  promptVersion: string
  /** True when the input hash matched a recent run and we returned the
   *  cached set without calling Sonnet. */
  shortCircuited: boolean
  /** Diagnostics for observability — what we read. */
  diagnostics: {
    rollupCellsScanned: number
    personasScanned: number
    externalSignalsScanned: number
    attributionRolesScanned: number
    totalCouplesInCohort: number
  }
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 90
const SHORT_CIRCUIT_LOOKBACK_DAYS = 7
const DAY_MS = 86_400_000
// Limit how many rollup cells we serialise to the prompt. Anything more
// than this is noise + cost. We rank by spend desc so the highest-
// leverage cells lead the prompt.
const MAX_ROLLUP_CELLS = 60
// LLM budget. ~$0.10-0.30 per generation per spec.
const MAX_OUTPUT_TOKENS = 4000
const TEMPERATURE = 0.3

// ---------------------------------------------------------------------------
// Idempotency hashing
// ---------------------------------------------------------------------------

/**
 * Stable JSON stringification — keys are sorted at every level so two
 * objects with the same content produce the same string regardless of
 * key order. Required for hashing input data (key order from PostgREST
 * is undefined).
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts: string[] = []
  for (const k of keys) {
    parts.push(
      `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`,
    )
  }
  return `{${parts.join(',')}}`
}

interface InputHashShape {
  venueId: string
  windowDays: number
  rollupCells: RollupCellEvidence[]
  personaDistribution: CohortPersonaShareEvidence[]
  emergingThemes: CohortThemeShareEvidence[]
  externalSignals: ExternalSignalSummaryEvidence[]
  attributionRoles: AttributionRoleSummaryEvidence[]
}

function computeInputHash(shape: InputHashShape): string {
  return createHash('sha256').update(stableStringify(shape)).digest('hex')
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface RollupRowDb {
  channel: string
  persona_label: string | null
  time_window_start: string
  time_window_end: string
  spend_cents: number
  inquiries_count: number
  booked_count: number
  total_booked_value_cents: number
  cac_cents: number | null
  conversion_pct: number | null
  roi_pct: number | null
  payback_months: number | null
  n_too_small: boolean
  computed_at: string
}

async function loadLatestRollupCells(
  supabase: SupabaseClient,
  venueId: string,
  windowDays: number,
): Promise<RollupCellEvidence[]> {
  const { data, error } = await supabase
    .from('persona_channel_rollups')
    .select(
      'channel, persona_label, time_window_start, time_window_end, spend_cents, inquiries_count, booked_count, total_booked_value_cents, cac_cents, conversion_pct, roi_pct, payback_months, n_too_small, computed_at',
    )
    .eq('venue_id', venueId)
    .order('computed_at', { ascending: false })
    .limit(2000)
  if (error) {
    console.warn('[marketing-recommendations] loadLatestRollupCells failed', {
      error: error.message,
    })
    return []
  }
  const rows = (data ?? []) as RollupRowDb[]
  if (rows.length === 0) return []

  // Filter to the rows whose window length matches windowDays (±1 day).
  const matching = rows.filter((r) => {
    const startMs = Date.parse(r.time_window_start)
    const endMs = Date.parse(r.time_window_end)
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false
    const lenDays = Math.round((endMs - startMs) / DAY_MS)
    return Math.abs(lenDays - windowDays) <= 1
  })
  if (matching.length === 0) return []

  // Pick the latest computed_at within the matching set.
  const latestComputedAt = matching[0].computed_at
  const latestStart = matching[0].time_window_start
  const latestEnd = matching[0].time_window_end
  const cells = matching.filter(
    (r) =>
      r.computed_at === latestComputedAt &&
      r.time_window_start === latestStart &&
      r.time_window_end === latestEnd,
  )

  // Map to evidence shape. Use windowDays rounded — the rollup row may
  // be off-by-one due to date math.
  const evidenceCells: RollupCellEvidence[] = cells.map((r) => ({
    channel: r.channel,
    persona_label: r.persona_label,
    window_days: windowDays,
    spend_cents: r.spend_cents,
    inquiries_count: r.inquiries_count,
    booked_count: r.booked_count,
    total_booked_value_cents: r.total_booked_value_cents,
    cac_cents: r.cac_cents,
    conversion_pct:
      r.conversion_pct === null ? null : Number(r.conversion_pct),
    roi_pct: r.roi_pct === null ? null : Number(r.roi_pct),
    payback_months:
      r.payback_months === null ? null : Number(r.payback_months),
    n_too_small: r.n_too_small,
  }))

  // Rank by spend desc + cap.
  evidenceCells.sort((a, b) => b.spend_cents - a.spend_cents)
  return evidenceCells.slice(0, MAX_ROLLUP_CELLS)
}

async function loadPersonaDistribution(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<{
  distribution: CohortPersonaShareEvidence[]
  totalCouples: number
}> {
  // Two-step: weddings ids for this venue, then couple_intel filtered.
  const { data: weds } = await supabase
    .from('weddings')
    .select('id')
    .eq('venue_id', venueId)
    .limit(1000)
  if (!weds) return { distribution: [], totalCouples: 0 }
  const ids = (weds as Array<{ id: string }>).map((w) => w.id)
  if (ids.length === 0) return { distribution: [], totalCouples: 0 }

  const counts = new Map<string, number>()
  let totalWithIntel = 0
  const BATCH = 100
  for (let i = 0; i < ids.length; i += BATCH) {
    const slice = ids.slice(i, i + BATCH)
    const { data } = await supabase
      .from('couple_intel')
      .select('persona_label, last_derived_at, wedding_id')
      .in('wedding_id', slice)
      .gte('last_derived_at', windowStartIso)
    for (const r of (data ?? []) as Array<{
      persona_label: string | null
    }>) {
      totalWithIntel += 1
      if (!r.persona_label) continue
      counts.set(r.persona_label, (counts.get(r.persona_label) ?? 0) + 1)
    }
  }
  if (counts.size === 0) {
    return { distribution: [], totalCouples: totalWithIntel }
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  const out: CohortPersonaShareEvidence[] = []
  for (const [label, n] of counts.entries()) {
    out.push({
      persona_label: label,
      share_pct: total === 0 ? 0 : Math.round((n / total) * 100),
      n_couples: n,
    })
  }
  out.sort((a, b) => b.share_pct - a.share_pct)
  return { distribution: out, totalCouples: totalWithIntel }
}

async function loadEmergingThemes(
  supabase: SupabaseClient,
  venueId: string,
): Promise<CohortThemeShareEvidence[]> {
  const { data } = await supabase
    .from('venue_intel')
    .select('rollup')
    .eq('venue_id', venueId)
    .maybeSingle()
  const rollup = (data as { rollup?: CohortRollupOutput } | null)?.rollup
  if (!rollup) return []
  const out: CohortThemeShareEvidence[] = []
  for (const t of rollup.emerging_themes ?? []) {
    if (t.sensitivity_filtered_count > 0 && t.evidence_count === 0) continue
    out.push({
      theme: t.theme,
      trend:
        t.trend === 'rising' ||
        t.trend === 'steady' ||
        t.trend === 'declining'
          ? t.trend
          : 'unknown',
      evidence_count: t.evidence_count,
    })
  }
  return out.slice(0, 8)
}

interface IntelMatchRow {
  signal_type: string
  signal_payload: Record<string, unknown> | null
  match_reasoning: string | null
  cohort_fit_score_0_100: number | null
  fired_at: string
}

async function loadExternalSignals(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<ExternalSignalSummaryEvidence[]> {
  const { data, error } = await supabase
    .from('intel_matches')
    .select(
      'signal_type, signal_payload, match_reasoning, cohort_fit_score_0_100, fired_at',
    )
    .eq('venue_id', venueId)
    .gte('fired_at', windowStartIso)
    .order('fired_at', { ascending: false })
    .limit(40)
  if (error) {
    console.warn('[marketing-recommendations] loadExternalSignals failed', {
      error: error.message,
    })
    return []
  }
  const rows = (data ?? []) as IntelMatchRow[]
  const out: ExternalSignalSummaryEvidence[] = []
  for (const r of rows) {
    const payload = r.signal_payload ?? {}
    const title =
      (payload['title'] as string | undefined) ??
      (payload['vendor_name'] as string | undefined) ??
      (payload['competitor_name'] as string | undefined) ??
      (payload['comparison'] as string | undefined) ??
      (payload['platform'] as string | undefined) ??
      r.signal_type
    out.push({
      signal_type: r.signal_type,
      title: String(title),
      cohort_fit_score_0_100: r.cohort_fit_score_0_100,
      reasoning_brief:
        r.match_reasoning && r.match_reasoning.length > 200
          ? r.match_reasoning.slice(0, 200) + '…'
          : r.match_reasoning,
    })
  }
  return out.slice(0, 10)
}

interface AttributionEventRow {
  source_platform: string | null
  role: string | null
  decided_at: string
}

async function loadAttributionRoleDistribution(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<AttributionRoleSummaryEvidence[]> {
  const { data, error } = await supabase
    .from('attribution_events')
    .select('source_platform, role, decided_at')
    .eq('venue_id', venueId)
    .is('reverted_at', null)
    .gte('decided_at', windowStartIso)
    .limit(5000)
  if (error) {
    console.warn(
      '[marketing-recommendations] loadAttributionRoleDistribution failed',
      { error: error.message },
    )
    return []
  }
  const rows = (data ?? []) as AttributionEventRow[]
  const byChannel = new Map<
    string,
    { acquisition: number; validation: number; conversion: number }
  >()
  for (const r of rows) {
    if (!r.source_platform) continue
    const ch = r.source_platform
    const acc = byChannel.get(ch) ?? {
      acquisition: 0,
      validation: 0,
      conversion: 0,
    }
    if (r.role === 'acquisition') acc.acquisition += 1
    else if (r.role === 'validation') acc.validation += 1
    else if (r.role === 'conversion') acc.conversion += 1
    byChannel.set(ch, acc)
  }
  const out: AttributionRoleSummaryEvidence[] = []
  for (const [channel, counts] of byChannel.entries()) {
    if (counts.acquisition + counts.validation + counts.conversion === 0) {
      continue
    }
    out.push({
      channel,
      acquisition_count: counts.acquisition,
      validation_count: counts.validation,
      conversion_count: counts.conversion,
    })
  }
  // Sort by total count desc.
  out.sort((a, b) => {
    const aTotal = a.acquisition_count + a.validation_count + a.conversion_count
    const bTotal = b.acquisition_count + b.validation_count + b.conversion_count
    return bTotal - aTotal
  })
  return out.slice(0, 12)
}

// ---------------------------------------------------------------------------
// Idempotency check
// ---------------------------------------------------------------------------

interface RecentRunRow {
  id: string
  generated_at: string
}

async function findRecentRunByHash(
  supabase: SupabaseClient,
  venueId: string,
  inputHash: string,
): Promise<RecentRunRow | null> {
  const sinceIso = new Date(
    Date.now() - SHORT_CIRCUIT_LOOKBACK_DAYS * DAY_MS,
  ).toISOString()
  const { data, error } = await supabase
    .from('marketing_recommendations')
    .select('id, generated_at')
    .eq('venue_id', venueId)
    .eq('input_data_hash', inputHash)
    .gte('generated_at', sinceIso)
    .order('generated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    // Maybe-single throws when 0 rows; we treat that as "no recent run".
    if (
      error.code === 'PGRST116' ||
      /multiple\s+rows/i.test(error.message)
    ) {
      return null
    }
    console.warn('[marketing-recommendations] findRecentRunByHash failed', {
      error: error.message,
    })
    return null
  }
  return (data as RecentRunRow | null) ?? null
}

// ---------------------------------------------------------------------------
// Venue label lookup
// ---------------------------------------------------------------------------

async function loadVenueLabel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  return ((data as { name?: string | null } | null)?.name ?? null) || null
}

// ---------------------------------------------------------------------------
// JSON fence stripping (defensive — Sonnet sometimes wraps)
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function generateMarketingRecommendations(
  venueId: string,
  options: GenerateMarketingRecommendationsOptions = {},
): Promise<GenerateMarketingRecommendationsResult> {
  const supabase = options.supabase ?? createServiceClient()
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS
  const correlationId = options.correlationId
  const force = options.force === true

  const windowStartIso = new Date(
    Date.now() - windowDays * DAY_MS,
  ).toISOString()

  // 1. Load everything in parallel.
  const [
    venueLabel,
    rollupCells,
    personaResult,
    emergingThemes,
    externalSignals,
    attributionRoles,
  ] = await Promise.all([
    loadVenueLabel(supabase, venueId),
    loadLatestRollupCells(supabase, venueId, windowDays),
    loadPersonaDistribution(supabase, venueId, windowStartIso),
    loadEmergingThemes(supabase, venueId),
    loadExternalSignals(supabase, venueId, windowStartIso),
    loadAttributionRoleDistribution(supabase, venueId, windowStartIso),
  ])

  const evidence: MarketingRecommendationsEvidence = {
    venueId,
    venueLabel,
    windowDays,
    totalCouplesInCohort: personaResult.totalCouples,
    rollupCells,
    personaDistribution: personaResult.distribution,
    emergingThemes,
    externalSignals,
    attributionRoles,
  }

  const diagnostics = {
    rollupCellsScanned: rollupCells.length,
    personasScanned: personaResult.distribution.length,
    externalSignalsScanned: externalSignals.length,
    attributionRolesScanned: attributionRoles.length,
    totalCouplesInCohort: personaResult.totalCouples,
  }

  // 2. Hash input.
  const inputHash = computeInputHash({
    venueId,
    windowDays,
    rollupCells,
    personaDistribution: personaResult.distribution,
    emergingThemes,
    externalSignals,
    attributionRoles,
  })

  // 3. Short-circuit if we already produced a rec set with this hash in
  //    the last 7 days (and force is not set).
  if (!force) {
    const recent = await findRecentRunByHash(supabase, venueId, inputHash)
    if (recent) {
      return {
        ok: true,
        venueId,
        recommendations: [],
        refusals: [],
        inserted: 0,
        costCents: 0,
        idempotencyHash: inputHash,
        promptVersion: MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
        shortCircuited: true,
        diagnostics,
      }
    }
  }

  // 4. If the rollup substrate is completely empty, refuse upfront —
  //    don't waste a Sonnet call to learn there's nothing to recommend.
  if (rollupCells.length === 0) {
    return {
      ok: true,
      venueId,
      recommendations: [],
      refusals: [
        {
          field: 'rollup',
          reason:
            'No persona × channel rollup cells available. Run the Wave 6B rollup recompute first (or marketing spend may not be recorded yet).',
        },
      ],
      inserted: 0,
      costCents: 0,
      idempotencyHash: inputHash,
      promptVersion: MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
      shortCircuited: false,
      diagnostics,
    }
  }

  // 5. Call Sonnet.
  const systemPrompt = buildMarketingRecommendationsSystemPrompt()
  const userPrompt = buildMarketingRecommendationsUserPrompt(evidence)

  // We call callAI directly (not callAIJson) so we can capture the
  // exact cost in cents per the same pattern Wave 5B uses.
  const aiResult = await callAI({
    systemPrompt:
      systemPrompt +
      '\n\nRespond with valid JSON only. No markdown, no code blocks, no explanation.',
    userPrompt,
    tier: 'sonnet',
    taskType: 'marketing_recommendations',
    contentTier: 4, // anonymised cohort summaries only
    promptVersion: MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
    venueId,
    maxTokens: MAX_OUTPUT_TOKENS,
    temperature: TEMPERATURE,
    correlationId,
  })

  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message =
      parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `generateMarketingRecommendations: LLM returned non-JSON. parseError=${message} rawResponse=${cleaned.slice(
        0,
        2000,
      )}`,
    )
  }

  const validation = validateMarketingRecommendationsOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `generateMarketingRecommendations: schema validation failed. error=${validation.error} rawResponse=${cleaned.slice(
        0,
        2000,
      )}`,
    )
  }
  const output = validation.output
  const costCents = aiResult.cost * 100

  // 6. Insert each recommendation as a new row.
  let inserted = 0
  for (const rec of output.recommendations) {
    try {
      const { error } = await supabase
        .from('marketing_recommendations')
        .insert({
          venue_id: venueId,
          recommendation_title: rec.recommendation_title,
          recommendation_text: rec.recommendation_text,
          action_type: rec.action_type,
          source_channel: rec.source_channel,
          target_channel: rec.target_channel,
          target_persona: rec.target_persona,
          estimated_monthly_dollar_impact_cents:
            rec.estimated_monthly_dollar_impact_cents,
          confidence_0_100: rec.confidence_0_100,
          reasoning_chain: rec.reasoning_chain,
          input_data_hash: inputHash,
          n_too_small_warning: rec.n_too_small_warning,
          status: 'pending',
          prompt_version: MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
          // Cost is the per-RUN cost; we attribute the full run cost to
          // the first row only so summing cost_cents across rows for a
          // single run reflects the actual spend (not n × cost).
          cost_cents: inserted === 0 ? costCents : 0,
        })
      if (error) {
        console.warn(
          '[marketing-recommendations] insert failed:',
          error.message,
        )
        continue
      }
      inserted += 1
    } catch (err) {
      console.warn(
        '[marketing-recommendations] insert threw:',
        err instanceof Error ? err.message : err,
      )
    }
  }

  return {
    ok: true,
    venueId,
    recommendations: output.recommendations,
    refusals: output.refusals,
    inserted,
    costCents,
    idempotencyHash: inputHash,
    promptVersion: MARKETING_RECOMMENDATIONS_PROMPT_VERSION,
    shortCircuited: false,
    diagnostics,
  }
}

// ---------------------------------------------------------------------------
// Read helpers (used by endpoints + UI)
// ---------------------------------------------------------------------------

export interface StoredMarketingRecommendationRow {
  id: string
  venue_id: string
  recommendation_title: string
  recommendation_text: string
  action_type: string
  source_channel: string | null
  target_channel: string | null
  target_persona: string | null
  estimated_monthly_dollar_impact_cents: number | null
  confidence_0_100: number
  reasoning_chain: Record<string, unknown>
  input_data_hash: string
  n_too_small_warning: boolean
  generated_at: string
  status: string
  decided_at: string | null
  decided_by: string | null
  decision_note: string | null
  actioned_at: string | null
  measured_outcome_cents: number | null
  prompt_version: string
  cost_cents: number | string
  created_at: string
}

export interface ListRecommendationsOptions {
  status?: string
  limit?: number
}

export async function listMarketingRecommendations(
  venueId: string,
  options: ListRecommendationsOptions = {},
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredMarketingRecommendationRow[]> {
  const limit = Math.min(options.limit ?? 200, 1000)
  let query = supabase
    .from('marketing_recommendations')
    .select(
      'id, venue_id, recommendation_title, recommendation_text, action_type, source_channel, target_channel, target_persona, estimated_monthly_dollar_impact_cents, confidence_0_100, reasoning_chain, input_data_hash, n_too_small_warning, generated_at, status, decided_at, decided_by, decision_note, actioned_at, measured_outcome_cents, prompt_version, cost_cents, created_at',
    )
    .eq('venue_id', venueId)
    .order('generated_at', { ascending: false })
    .limit(limit)

  if (options.status) {
    query = query.eq('status', options.status)
  }

  const { data, error } = await query
  if (error) {
    throw new Error(`listMarketingRecommendations: ${error.message}`)
  }
  return (data ?? []) as StoredMarketingRecommendationRow[]
}

export async function getMarketingRecommendation(
  recommendationId: string,
  supabase: SupabaseClient = createServiceClient(),
): Promise<StoredMarketingRecommendationRow | null> {
  const { data, error } = await supabase
    .from('marketing_recommendations')
    .select(
      'id, venue_id, recommendation_title, recommendation_text, action_type, source_channel, target_channel, target_persona, estimated_monthly_dollar_impact_cents, confidence_0_100, reasoning_chain, input_data_hash, n_too_small_warning, generated_at, status, decided_at, decided_by, decision_note, actioned_at, measured_outcome_cents, prompt_version, cost_cents, created_at',
    )
    .eq('id', recommendationId)
    .maybeSingle()
  if (error) {
    throw new Error(`getMarketingRecommendation: ${error.message}`)
  }
  return (data as StoredMarketingRecommendationRow | null) ?? null
}

export interface DecideRecommendationInput {
  decision: 'accepted' | 'declined' | 'in_progress' | 'completed'
  note?: string | null
  decidedBy?: string | null
}

export async function decideMarketingRecommendation(
  recommendationId: string,
  input: DecideRecommendationInput,
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const update: Record<string, unknown> = {
    status: input.decision,
    decided_at: new Date().toISOString(),
  }
  if (input.note !== undefined) update.decision_note = input.note
  if (input.decidedBy !== undefined) update.decided_by = input.decidedBy
  if (input.decision === 'in_progress' || input.decision === 'completed') {
    update.actioned_at = new Date().toISOString()
  }
  const { error } = await supabase
    .from('marketing_recommendations')
    .update(update)
    .eq('id', recommendationId)
  if (error) {
    throw new Error(`decideMarketingRecommendation: ${error.message}`)
  }
}

export async function measureMarketingRecommendation(
  recommendationId: string,
  measuredOutcomeCents: number,
  supabase: SupabaseClient = createServiceClient(),
): Promise<void> {
  const { error } = await supabase
    .from('marketing_recommendations')
    .update({
      measured_outcome_cents: Math.round(measuredOutcomeCents),
      // Auto-promote to 'completed' when an outcome is recorded.
      status: 'completed',
      actioned_at: new Date().toISOString(),
    })
    .eq('id', recommendationId)
  if (error) {
    throw new Error(`measureMarketingRecommendation: ${error.message}`)
  }
}
