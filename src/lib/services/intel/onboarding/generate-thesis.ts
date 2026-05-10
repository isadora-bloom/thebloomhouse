/**
 * Bloom House — Wave 5D venue thesis generator service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5D auto-generates a venue's "thesis"
 *     once ~50 reconstructions have landed — onboarding is never blank)
 *   - bloom-wave4-5-6-master-plan.md (Wave 5D spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose; the thesis
 *     reads anonymised cohort summaries and never names couples)
 *   - bloom-may9-llm-vs-template.md (every "AI" surface is a real
 *     callAI; thesis is the Sonnet synthesizer behind the dashboard)
 *
 * What this service does
 * ----------------------
 * Given a venueId, gather:
 *   - cohort size (couple_identity_profile rows for this venue)
 *   - persona distribution (couple_intel.persona_label across the venue)
 *   - close-probability bucket distribution (Wave 5A)
 *   - wedding-source distribution (weddings.source)
 *   - sensitive-theme COUNTS (extracted from couple_identity_profile)
 *   - Wave 5B venue_intel rollup summary
 *   - Wave 7B attribution_events role distribution per channel
 *   - Wave 6B persona_channel_rollups top cells
 *   - cross-venue persona-distribution baseline (when other venues exist)
 *
 * Feed all of this into ONE Sonnet call. Parse + validate. Upsert into
 * venue_thesis.
 *
 * Cost target: ~$0.10-$0.20 per generation. One call per venue, low
 * volume (one per venue per week).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  VENUE_THESIS_PROMPT_VERSION,
  buildVenueThesisSystemPrompt,
  buildVenueThesisUserPrompt,
  validateVenueThesisOutput,
  type VenueThesisOutput,
  type VenueThesisEvidence,
  type PersonaDistributionEntry,
  type CloseProbBucket,
  type SourceDistributionEntry,
  type ChannelRoleDistributionEntry,
  type PersonaChannelRollupSummary,
  type CohortRollupSummary,
} from '@/config/prompts/venue-thesis'
import type { CoupleIdentityProfile, EmotionalTruth } from '@/config/prompts/identity-reconstruction'
import type { CohortRollupOutput } from '@/config/prompts/cohort-rollup'

// Re-export so callers don't have to import from two places.
export {
  VENUE_THESIS_PROMPT_VERSION,
  type VenueThesisOutput,
} from '@/config/prompts/venue-thesis'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateVenueThesisResult {
  thesis: VenueThesisOutput
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
  cohortSize: number
}

export interface GenerateVenueThesisOptions {
  /** Optional client override (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
  /** Trailing window for cohort considered. Default 365 (a year — wider
   *  than 5B's 90 because the thesis is a strategic identity not a
   *  freshness rollup). */
  windowDays?: number
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 365
const ID_BATCH_SIZE = 100
const MAX_PERSONA_CHANNEL_CELLS = 12
const MAX_OTHER_VENUES_FOR_BASELINE = 5000

const CLOSE_PROB_BUCKETS: Array<{ label: string; min: number; max: number }> =
  [
    { label: '0-20', min: 0, max: 20 },
    { label: '20-40', min: 20, max: 40 },
    { label: '40-60', min: 40, max: 60 },
    { label: '60-80', min: 60, max: 80 },
    { label: '80-100', min: 80, max: 101 }, // include 100
  ]

const SENSITIVE_THEME_KEYS: Array<{ category: string; needles: string[] }> = [
  { category: 'medical', needles: ['medical', 'illness', 'cancer', 'surgery', 'diagnosis'] },
  { category: 'grief', needles: ['grief', 'loss', 'bereave', 'passed away', 'death'] },
  { category: 'financial_stress', needles: ['financial', 'money', 'budget', 'tight'] },
  { category: 'family_conflict', needles: ['family conflict', 'estranged', 'divorce', 'feud'] },
  { category: 'mental_health', needles: ['mental', 'anxiety', 'depression', 'panic'] },
]

// ---------------------------------------------------------------------------
// Loaders
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

interface ProfileRow {
  wedding_id: string
  venue_id: string
  profile: CoupleIdentityProfile
  last_reconstructed_at: string
  last_signal_at: string | null
}

async function loadProfilesForWindow(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<ProfileRow[]> {
  const { data, error } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id, venue_id, profile, last_reconstructed_at, last_signal_at')
    .eq('venue_id', venueId)
    .order('last_reconstructed_at', { ascending: false })
    .limit(1000)
  if (error) {
    throw new Error(`generate-thesis.loadProfilesForWindow: ${error.message}`)
  }
  const all = (data ?? []) as ProfileRow[]
  const startMs = Date.parse(windowStartIso)
  if (!Number.isFinite(startMs)) return all
  return all.filter((row) => {
    const a = row.last_signal_at ? Date.parse(row.last_signal_at) : 0
    const b = Date.parse(row.last_reconstructed_at)
    const fresh = Math.max(a, b)
    return fresh >= startMs
  })
}

interface IntelRow {
  wedding_id: string
  persona_label: string | null
  predicted_close_probability_pct: number | null
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

async function loadIntelForWeddings(
  supabase: SupabaseClient,
  weddingIds: string[],
): Promise<Map<string, IntelRow>> {
  if (weddingIds.length === 0) return new Map()
  const out = new Map<string, IntelRow>()
  for (const batch of chunk(weddingIds, ID_BATCH_SIZE)) {
    const { data } = await supabase
      .from('couple_intel')
      .select('wedding_id, persona_label, predicted_close_probability_pct')
      .in('wedding_id', batch)
    for (const r of (data ?? []) as IntelRow[]) {
      out.set(r.wedding_id, r)
    }
  }
  return out
}

interface WeddingRow {
  id: string
  source: string | null
  status: string | null
  merged_into_id: string | null
}

async function loadWeddings(
  supabase: SupabaseClient,
  weddingIds: string[],
): Promise<Map<string, WeddingRow>> {
  if (weddingIds.length === 0) return new Map()
  const out = new Map<string, WeddingRow>()
  for (const batch of chunk(weddingIds, ID_BATCH_SIZE)) {
    const { data } = await supabase
      .from('weddings')
      .select('id, source, status, merged_into_id')
      .in('id', batch)
    for (const w of (data ?? []) as WeddingRow[]) {
      if (w.merged_into_id) continue
      out.set(w.id, w)
    }
  }
  return out
}

interface VenueIntelRow {
  venue_id: string
  rollup: CohortRollupOutput
  source_window_days: number
  couples_in_window: number
}

async function loadVenueIntel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<VenueIntelRow | null> {
  const { data } = await supabase
    .from('venue_intel')
    .select('venue_id, rollup, source_window_days, couples_in_window')
    .eq('venue_id', venueId)
    .maybeSingle()
  return (data as VenueIntelRow | null) ?? null
}

interface AttributionEventRoleRow {
  source_platform: string | null
  role: string | null
}

async function loadAttributionRoleDistribution(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ChannelRoleDistributionEntry[]> {
  // attribution_events keyed by venue (mig 105 + 264 added .role).
  const { data, error } = await supabase
    .from('attribution_events')
    .select('source_platform, role')
    .eq('venue_id', venueId)
    .limit(20_000)
  if (error) {
    console.warn(
      '[generate-thesis] loadAttributionRoleDistribution failed:',
      error.message,
    )
    return []
  }
  const byChannel = new Map<string, ChannelRoleDistributionEntry>()
  for (const r of (data ?? []) as AttributionEventRoleRow[]) {
    const ch = (r.source_platform ?? 'unknown').toLowerCase()
    const role = (r.role ?? 'unknown').toLowerCase()
    let cell = byChannel.get(ch)
    if (!cell) {
      cell = {
        channel: ch,
        acquisition: 0,
        validation: 0,
        conversion: 0,
        mixed: 0,
        unknown: 0,
      }
      byChannel.set(ch, cell)
    }
    if (role === 'acquisition') cell.acquisition += 1
    else if (role === 'validation') cell.validation += 1
    else if (role === 'conversion') cell.conversion += 1
    else if (role === 'mixed') cell.mixed += 1
    else cell.unknown += 1
  }
  return Array.from(byChannel.values()).sort(
    (a, b) =>
      b.acquisition + b.validation + b.conversion + b.mixed + b.unknown -
      (a.acquisition + a.validation + a.conversion + a.mixed + a.unknown),
  )
}

interface PersonaChannelRollupRow {
  channel: string
  persona_label: string | null
  inquiries_count: number
  booked_count: number
  conversion_pct: number | null
  cac_cents: number | null
  time_window_end: string
}

async function loadPersonaChannelRollupTop(
  supabase: SupabaseClient,
  venueId: string,
): Promise<PersonaChannelRollupSummary[]> {
  const { data, error } = await supabase
    .from('persona_channel_rollups')
    .select(
      'channel, persona_label, inquiries_count, booked_count, conversion_pct, cac_cents, time_window_end',
    )
    .eq('venue_id', venueId)
    .order('time_window_end', { ascending: false })
    .limit(200)
  if (error) {
    console.warn('[generate-thesis] loadPersonaChannelRollupTop failed:', error.message)
    return []
  }
  const rows = (data ?? []) as PersonaChannelRollupRow[]
  // Sort by inquiries_count desc, take top N.
  rows.sort((a, b) => (b.inquiries_count ?? 0) - (a.inquiries_count ?? 0))
  const top = rows.slice(0, MAX_PERSONA_CHANNEL_CELLS)
  return top.map((r) => ({
    channel: r.channel,
    persona_label: r.persona_label,
    n_inquiries: r.inquiries_count ?? 0,
    n_booked: r.booked_count ?? 0,
    conversion_pct: r.conversion_pct,
    cac_cents: r.cac_cents,
  }))
}

async function loadMarketPersonaBaseline(
  supabase: SupabaseClient,
  excludeVenueId: string,
): Promise<PersonaDistributionEntry[] | null> {
  const { data: weds } = await supabase
    .from('weddings')
    .select('id, venue_id')
    .neq('venue_id', excludeVenueId)
    .limit(MAX_OTHER_VENUES_FOR_BASELINE)
  if (!weds || weds.length === 0) return null
  const ids = (weds as Array<{ id: string }>).map((w) => w.id)
  const counts = new Map<string, number>()
  for (const batch of chunk(ids, ID_BATCH_SIZE)) {
    const { data } = await supabase
      .from('couple_intel')
      .select('persona_label')
      .in('wedding_id', batch)
    for (const r of (data ?? []) as Array<{ persona_label: string | null }>) {
      if (!r.persona_label) continue
      counts.set(r.persona_label, (counts.get(r.persona_label) ?? 0) + 1)
    }
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  if (total === 0) return null
  const out: PersonaDistributionEntry[] = []
  for (const [label, n] of counts.entries()) {
    out.push({
      persona_label: label,
      share_pct: Math.round((n / total) * 100),
      n_couples: n,
    })
  }
  out.sort((a, b) => b.share_pct - a.share_pct)
  return out
}

// ---------------------------------------------------------------------------
// Aggregators
// ---------------------------------------------------------------------------

function buildPersonaDistribution(
  intelMap: Map<string, IntelRow>,
): PersonaDistributionEntry[] {
  const counts = new Map<string, number>()
  for (const r of intelMap.values()) {
    if (!r.persona_label) continue
    counts.set(r.persona_label, (counts.get(r.persona_label) ?? 0) + 1)
  }
  const total = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  if (total === 0) return []
  const out: PersonaDistributionEntry[] = []
  for (const [label, n] of counts.entries()) {
    out.push({
      persona_label: label,
      share_pct: Math.round((n / total) * 100),
      n_couples: n,
    })
  }
  out.sort((a, b) => b.share_pct - a.share_pct)
  return out
}

function buildCloseProbDistribution(
  intelMap: Map<string, IntelRow>,
): CloseProbBucket[] {
  const counts: CloseProbBucket[] = CLOSE_PROB_BUCKETS.map((b) => ({
    bucket: b.label,
    n_couples: 0,
  }))
  for (const r of intelMap.values()) {
    const p = r.predicted_close_probability_pct
    if (p === null || p === undefined) continue
    for (let i = 0; i < CLOSE_PROB_BUCKETS.length; i++) {
      const bk = CLOSE_PROB_BUCKETS[i]
      if (p >= bk.min && p < bk.max) {
        counts[i].n_couples += 1
        break
      }
    }
  }
  return counts.filter((b) => b.n_couples > 0)
}

function buildSourceDistribution(
  weddingMap: Map<string, WeddingRow>,
): SourceDistributionEntry[] {
  const counts = new Map<string, number>()
  for (const w of weddingMap.values()) {
    const src = w.source ?? 'unknown'
    counts.set(src, (counts.get(src) ?? 0) + 1)
  }
  const out: SourceDistributionEntry[] = []
  for (const [source, n] of counts.entries()) {
    out.push({ source, n_couples: n })
  }
  out.sort((a, b) => b.n_couples - a.n_couples)
  return out
}

function buildSensitivityCounts(profiles: ProfileRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const p of profiles) {
    const truths = (p.profile?.emotional_truths ?? []) as EmotionalTruth[]
    const seenForCouple = new Set<string>()
    for (const t of truths) {
      if (!t.sensitive) continue
      const lower = (t.theme ?? '').toLowerCase()
      let category: string | null = null
      for (const sk of SENSITIVE_THEME_KEYS) {
        if (sk.needles.some((n) => lower.includes(n))) {
          category = sk.category
          break
        }
      }
      if (!category) category = 'sensitive_other'
      if (seenForCouple.has(category)) continue
      seenForCouple.add(category)
      counts[category] = (counts[category] ?? 0) + 1
    }
  }
  return counts
}

function summariseCohortRollup(
  rollup: CohortRollupOutput | null,
): CohortRollupSummary | null {
  if (!rollup) return null
  const themesTop = (rollup.emerging_themes ?? [])
    .slice(0, 6)
    .map((t) => ({
      theme: t.theme,
      trend: t.trend,
      evidence_count: t.evidence_count,
    }))
  const corrTop = (rollup.conversion_correlations ?? [])
    .slice(0, 6)
    .map((c) => ({
      signal: c.signal,
      outcome: c.outcome,
      lift_pct: c.lift_pct,
      n_couples: c.n_couples,
    }))
  const voicePersonas = Array.from(
    new Set((rollup.voice_calibration ?? []).map((v) => v.persona_label)),
  ).filter(Boolean)
  const demandTop = (rollup.service_demand_map ?? [])
    .slice(0, 6)
    .map((s) => ({
      service_or_offering: s.service_or_offering,
      demand_signal: s.demand_signal,
      currently_offered: s.currently_offered,
    }))
  const timingTop = (rollup.timing_patterns ?? [])
    .slice(0, 6)
    .map((t) => ({ pattern: t.pattern }))
  return {
    emerging_themes_top: themesTop,
    conversion_correlations_top: corrTop,
    voice_calibration_personas: voicePersonas,
    service_demand_top: demandTop,
    timing_patterns_top: timingTop,
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

/**
 * Generate the thesis for a venue. ONE Sonnet call. Upserts into
 * venue_thesis (existing row's generation_count is incremented).
 *
 * Throws on:
 *   - venue not found
 *   - LLM call fails (callAI handles fallback; if both fail, throws)
 *   - LLM response cannot be JSON-parsed or fails schema validation
 *
 * Empty-cohort fast path: when the venue has zero reconstructed
 * couples, returns a refusal thesis (well-formed empty state) without
 * spending Sonnet — the dashboard renders the empty state.
 */
export async function generateVenueThesis(
  venueId: string,
  options: GenerateVenueThesisOptions = {},
): Promise<GenerateVenueThesisResult> {
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS

  const windowStartMs = Date.now() - windowDays * 86_400_000
  const windowStartIso = new Date(windowStartMs).toISOString()

  const venue = await loadVenue(supabase, venueId)
  if (!venue) {
    throw new Error(`generateVenueThesis: venue ${venueId} not found`)
  }

  const profiles = await loadProfilesForWindow(supabase, venueId, windowStartIso)
  const cohortSize = profiles.length

  // Empty-cohort fast path. No Sonnet spend.
  if (cohortSize === 0) {
    const empty: VenueThesisOutput = {
      venue_archetype: {
        label: 'Pre-cohort',
        description: 'No reconstructed couples in scope yet.',
        evidence_summary:
          'Venue has zero couple_identity_profile rows in the trailing window. ' +
          'Once Wave 4 produces ~30+ reconstructions, the thesis can synthesise.',
        confidence_0_100: 0,
      },
      over_indexed_personas: [],
      recurring_emotional_landscape: [],
      conversion_signature: [],
      voice_thesis: {
        tone_descriptors: [],
        language_that_lands: [],
        language_to_avoid: [],
        key_principles: [],
      },
      service_demand_strengths: [],
      service_demand_gaps: [],
      operator_brief_paragraph:
        'No reconstructed couples yet. Once the agent has reconstructed ~30 couples, the venue thesis will synthesise — telling you who books here, what voice resonates, and what services to invest in.',
      cohort_size_at_generation: 0,
      refusals: [
        {
          field: 'all',
          reason: `cohort_size=0 in last ${windowDays}d window for venue ${venueId}; thesis deferred until cohort exists`,
        },
      ],
    }
    await upsertVenueThesis({
      supabase,
      venueId,
      thesis: empty,
      cohortSize: 0,
      newCallCostCents: 0,
    })
    return {
      thesis: empty,
      costCents: 0,
      promptVersion: VENUE_THESIS_PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      cohortSize: 0,
    }
  }

  const weddingIds = profiles.map((p) => p.wedding_id)

  const [weddingMap, intelMap, venueIntel, channelRoleDist, personaChannelTop, marketBaseline] =
    await Promise.all([
      loadWeddings(supabase, weddingIds),
      loadIntelForWeddings(supabase, weddingIds),
      loadVenueIntel(supabase, venueId),
      loadAttributionRoleDistribution(supabase, venueId),
      loadPersonaChannelRollupTop(supabase, venueId),
      loadMarketPersonaBaseline(supabase, venueId),
    ])

  const personaDistribution = buildPersonaDistribution(intelMap)
  const closeProbDistribution = buildCloseProbDistribution(intelMap)
  const sourceDistribution = buildSourceDistribution(weddingMap)
  const sensitivityCounts = buildSensitivityCounts(profiles)
  const cohortRollupSummary = summariseCohortRollup(venueIntel?.rollup ?? null)

  const evidence: VenueThesisEvidence = {
    venueId,
    venueLabel: venue.name,
    venueState: venue.state,
    cohortSizeAtGeneration: cohortSize,
    windowDays,
    personaDistribution,
    closeProbDistribution,
    sourceDistribution,
    sensitivityCounts,
    cohortRollupSummary,
    channelRoleDistribution: channelRoleDist,
    personaChannelTop,
    marketPersonaBaseline: marketBaseline,
  }

  const systemPrompt = buildVenueThesisSystemPrompt()
  const userPrompt = buildVenueThesisUserPrompt(evidence)

  // Call Sonnet. Synthesizer tier — temperature 0.4 (matches the
  // strategic-prose generation profile; higher than 5B's 0.3 because
  // the operator_brief_paragraph benefits from a touch of voice).
  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'venue_thesis',
    contentTier: 4, // anonymised aggregates only
    promptVersion: VENUE_THESIS_PROMPT_VERSION,
    venueId,
    maxTokens: 4000,
    temperature: 0.4,
    correlationId,
  })

  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `generateVenueThesis: LLM returned non-JSON. parseError=${message} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const validation = validateVenueThesisOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `generateVenueThesis: schema validation failed. error=${validation.error} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }

  const thesis = validation.thesis
  // Force cohort_size_at_generation to the actual computed value.
  thesis.cohort_size_at_generation = cohortSize

  const newCallCostCents = aiResult.cost * 100

  await upsertVenueThesis({
    supabase,
    venueId,
    thesis,
    cohortSize,
    newCallCostCents,
  })

  return {
    thesis,
    costCents: newCallCostCents,
    promptVersion: VENUE_THESIS_PROMPT_VERSION,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
    cohortSize,
  }
}

// ---------------------------------------------------------------------------
// Upsert + read
// ---------------------------------------------------------------------------

interface UpsertVenueThesisInput {
  supabase: SupabaseClient
  venueId: string
  thesis: VenueThesisOutput
  cohortSize: number
  newCallCostCents: number
}

async function upsertVenueThesis(input: UpsertVenueThesisInput): Promise<void> {
  const { supabase, venueId, thesis, cohortSize, newCallCostCents } = input

  // Read existing row to accumulate cost + bump generation_count.
  const { data: existing } = await supabase
    .from('venue_thesis')
    .select('cost_cents, generation_count')
    .eq('venue_id', venueId)
    .maybeSingle()

  const existingCostCents = existing
    ? Number((existing as { cost_cents: number | string }).cost_cents) || 0
    : 0
  const cumulativeCostCents = existingCostCents + newCallCostCents

  const generationCount = existing
    ? Number((existing as { generation_count: number | string }).generation_count || 0) +
      1
    : 1

  const upsertRow = {
    venue_id: venueId,
    thesis,
    couples_at_generation: cohortSize,
    last_generated_at: new Date().toISOString(),
    generation_count: generationCount,
    prompt_version: VENUE_THESIS_PROMPT_VERSION,
    cost_cents: cumulativeCostCents,
    updated_at: new Date().toISOString(),
  }

  const { error: upsertErr } = await supabase
    .from('venue_thesis')
    .upsert(upsertRow, { onConflict: 'venue_id' })

  if (upsertErr) {
    throw new Error(`generateVenueThesis: upsert failed: ${upsertErr.message}`)
  }
}

export interface StoredVenueThesis {
  venueId: string
  thesis: VenueThesisOutput
  couplesAtGeneration: number
  lastGeneratedAt: string
  generationCount: number
  promptVersion: string
  costCents: number
}

export async function getStoredVenueThesis(
  venueId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<StoredVenueThesis | null> {
  const supabase = options.supabase ?? createServiceClient()
  const { data, error } = await supabase
    .from('venue_thesis')
    .select(
      'venue_id, thesis, couples_at_generation, last_generated_at, generation_count, prompt_version, cost_cents',
    )
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) {
    console.warn('[generate-thesis] getStoredVenueThesis failed:', error.message)
    return null
  }
  if (!data) return null
  const row = data as {
    venue_id: string
    thesis: VenueThesisOutput
    couples_at_generation: number
    last_generated_at: string
    generation_count: number
    prompt_version: string
    cost_cents: number | string
  }
  return {
    venueId: row.venue_id,
    thesis: row.thesis,
    couplesAtGeneration: row.couples_at_generation,
    lastGeneratedAt: row.last_generated_at,
    generationCount: row.generation_count,
    promptVersion: row.prompt_version,
    costCents: Number(row.cost_cents) || 0,
  }
}

// ---------------------------------------------------------------------------
// TODO: Trigger hook
// ---------------------------------------------------------------------------
//
// When couple_identity_profile inserts cross multiples of 25 (25/50/75/
// 100), enqueue a thesis generation with trigger_signal='cohort_milestone'
// via venue_thesis_jobs. This service does NOT auto-fire from inside
// reconstruct.ts — that's reserved for the reconciliation pass that
// owns the wider enqueue routing. For now, the sweep service in
// ./sweep.ts handles weekly_drift; manual triggers go through the
// /api/admin/onboarding/venue-thesis/generate endpoint.
