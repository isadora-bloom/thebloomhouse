/**
 * Bloom House — Wave 5B per-venue cohort rollup service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5B aggregates the per-couple substrate
 *     into venue-level intel: emerging themes, conversion correlations,
 *     voice calibration, service demand gaps, timing patterns)
 *   - bloom-wave4-5-6-master-plan.md (5B spec)
 *   - bloom-data-integrity-sweep.md (aggregate ≠ disclose. Sensitive
 *     themes report counts only; we strip sensitive evidence before it
 *     ever reaches the prompt)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; this service is a Sonnet
 *     aggregator)
 *
 * What this service does
 * ----------------------
 * Given a venueId + windowDays (default 90), gather the venue's couples
 * who have a Wave-4 forensic profile and (when present) Wave-5A
 * couple_intel, anonymise each couple's salient signals, feed them into
 * one Sonnet call, parse + validate, and upsert into venue_intel.
 *
 * Different LLM job from Wave 4 + 5A
 * ----------------------------------
 * Wave 4 is forensic extraction (verbatim evidence per claim).
 * Wave 5A is per-couple synthesis (persona + close-prob + brief).
 * Wave 5B is multi-couple pattern synthesis (emerging themes + cohort
 * correlations + voice calibration + service demand + timing).
 *
 * One LLM call per venue. Idempotent at the upsert layer.
 *
 * Cost target: ~$2-5 per rollup at 30-50 couples / venue.
 */

import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  buildSystemPrompt,
  buildUserPrompt,
  validateCohortRollupOutput,
  COHORT_ROLLUP_PROMPT_VERSION,
  type CohortRollupOutput,
  type CohortRollupEvidence,
  type AnonymisedCoupleSummary,
  type AnonymisedEmotionalTheme,
} from '@/config/prompts/cohort-rollup'
import type {
  CoupleIdentityProfile,
  EmotionalTruth,
} from '@/config/prompts/identity-reconstruction'
import type { CoupleIntelOutput } from '@/config/prompts/couple-intel-derive'

// Re-export so callers don't have to import from two places.
export {
  COHORT_ROLLUP_PROMPT_VERSION,
  type CohortRollupOutput,
} from '@/config/prompts/cohort-rollup'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RunCohortRollupResult {
  rollup: CohortRollupOutput
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
  couplesInWindow: number
  windowDays: number
}

export interface RunCohortRollupOptions {
  /** Trailing window length in days. Default 90. */
  windowDays?: number
  /** Optional client override (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const DEFAULT_WINDOW_DAYS = 90
const MAX_COUPLES_IN_PROMPT = 60
const MAX_COORDINATOR_BRIEF_CHARS = 360
const MAX_LIST_ITEMS = 8

// ---------------------------------------------------------------------------
// Anonymisation
// ---------------------------------------------------------------------------

/**
 * Stable anonymous label for a wedding within a rollup batch. The label
 * is deterministic from the wedding_id so re-running on the same data
 * produces the same labels (helps a reader correlate output across
 * runs). The label format is "Couple <Letter><Number>" where the
 * letter/number are derived from a hash, so two consecutive couples in
 * the same venue won't share a prefix and human readers won't pattern-
 * match by index.
 */
function anonLabel(weddingId: string, fallbackIndex: number): string {
  if (!weddingId) return `Couple Z${fallbackIndex}`
  const h = createHash('sha256').update(weddingId).digest()
  const letter = String.fromCharCode(65 + (h[0] % 26))
  const number = h[1] % 99 + 1
  return `Couple ${letter}${number}`
}

const SENSITIVE_THEME_CATEGORIES = new Set([
  'medical',
  'grief',
  'financial_stress',
  'family_conflict',
  'mental_health',
])

/**
 * Categorise an emotional truth's theme into one of the 5 sensitive
 * buckets, or null when the theme is non-sensitive. The Wave-4 prompt
 * tags `sensitive:true` on the theme entry; we use that tag as the
 * primary signal and the theme string as a coarse mapping for the
 * cohort-shape counts.
 */
function classifySensitiveCategory(theme: string): string | null {
  const lower = theme.toLowerCase()
  for (const cat of SENSITIVE_THEME_CATEGORIES) {
    if (lower.includes(cat) || lower.includes(cat.replace('_', ' '))) {
      return cat
    }
  }
  // Fallback labels. Some Wave-4 themes phrase the category differently
  // ("medical issue" → medical, "family fracture" → family_conflict,
  // "loss of a parent" → grief). Match the most common phrasings.
  if (lower.includes('grief') || lower.includes('loss')) return 'grief'
  if (lower.includes('illness') || lower.includes('medical')) return 'medical'
  if (lower.includes('finance') || lower.includes('money') || lower.includes('budget')) {
    return 'financial_stress'
  }
  if (lower.includes('family') && (lower.includes('conflict') || lower.includes('divorce'))) {
    return 'family_conflict'
  }
  if (lower.includes('mental') || lower.includes('anxiety') || lower.includes('depression')) {
    return 'mental_health'
  }
  return null
}

function partitionThemes(
  truths: EmotionalTruth[],
): {
  nonSensitive: AnonymisedEmotionalTheme[]
  sensitiveCategories: string[]
} {
  const nonSensitive: AnonymisedEmotionalTheme[] = []
  const sensitiveCategories: string[] = []
  for (const t of truths) {
    if (t.sensitive) {
      const cat = classifySensitiveCategory(t.theme) ?? 'sensitive_other'
      sensitiveCategories.push(cat)
    } else {
      nonSensitive.push({
        theme: t.theme,
        confidence_0_100: t.confidence_0_100,
        sensitive: false,
      })
    }
  }
  return { nonSensitive, sensitiveCategories }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

interface ProfileRow {
  wedding_id: string
  venue_id: string
  profile: CoupleIdentityProfile
  last_reconstructed_at: string
  last_signal_at: string | null
}

interface IntelRow {
  wedding_id: string
  intel: CoupleIntelOutput
  predicted_close_probability_pct: number | null
  persona_label: string | null
  last_derived_at: string
}

interface WeddingRow {
  id: string
  status: string | null
  source: string | null
  inquiry_date: string | null
  wedding_date: string | null
  booked_at: string | null
  merged_into_id: string | null
}

interface InteractionRow {
  wedding_id: string
  direction: string | null
  timestamp: string | null
}

async function loadVenueLabel(
  supabase: SupabaseClient,
  venueId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('venues')
    .select('name')
    .eq('id', venueId)
    .maybeSingle()
  return (data as { name?: string } | null)?.name ?? null
}

async function loadProfilesForWindow(
  supabase: SupabaseClient,
  venueId: string,
  windowStartIso: string,
): Promise<ProfileRow[]> {
  // We want couples whose forensic profile exists AND whose underlying
  // wedding falls within the window. The window is defined on
  // weddings.inquiry_date OR couple_identity_profile.last_signal_at —
  // the spec calls for either one falling within the window. Since
  // last_signal_at can be null on some rows, we OR with
  // last_reconstructed_at as a fallback freshness signal.
  const { data, error } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id, venue_id, profile, last_reconstructed_at, last_signal_at')
    .eq('venue_id', venueId)
    .order('last_reconstructed_at', { ascending: false })
    .limit(500)

  if (error) {
    throw new Error(`cohort-rollup.loadProfilesForWindow: ${error.message}`)
  }
  const all = (data ?? []) as ProfileRow[]
  // Apply the window filter in JS so we can OR last_signal_at +
  // last_reconstructed_at without a fragile PostgREST OR clause.
  const startMs = Date.parse(windowStartIso)
  if (!Number.isFinite(startMs)) return all
  return all.filter((row) => {
    const a = row.last_signal_at ? Date.parse(row.last_signal_at) : 0
    const b = Date.parse(row.last_reconstructed_at)
    const fresh = Math.max(a, b)
    return fresh >= startMs
  })
}

// PostgREST .in() with hundreds of IDs hits the URL length cap. Chunk
// to a safe batch size and merge results.
const ID_BATCH_SIZE = 100

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size))
  }
  return out
}

async function loadWeddings(
  supabase: SupabaseClient,
  weddingIds: string[],
  windowStartIso: string,
): Promise<Map<string, WeddingRow>> {
  if (weddingIds.length === 0) return new Map()
  const all: WeddingRow[] = []
  for (const batch of chunk(weddingIds, ID_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('weddings')
      .select(
        'id, status, source, inquiry_date, wedding_date, booked_at, merged_into_id',
      )
      .in('id', batch)
    if (error) {
      throw new Error(`cohort-rollup.loadWeddings: ${error.message}`)
    }
    all.push(...((data ?? []) as WeddingRow[]))
  }
  // Apply the window filter on inquiry_date here too. A couple counts
  // for the window if EITHER (a) its profile freshness is within the
  // window (already filtered upstream) OR (b) its inquiry_date is
  // within the window. The .filter below keeps both — we drop only
  // tombstoned weddings.
  const out = new Map<string, WeddingRow>()
  const startMs = Date.parse(windowStartIso)
  for (const w of all) {
    if (w.merged_into_id) continue
    // Window inclusion: ANY signal in the window. inquiry_date is the
    // most useful one here.
    const inq = w.inquiry_date ? Date.parse(w.inquiry_date) : 0
    if (!Number.isFinite(startMs) || inq >= startMs || w.booked_at) {
      out.set(w.id, w)
      continue
    }
    // The profile-freshness path also wins inclusion (already filtered
    // upstream) so include the row regardless — the cohort-rollup
    // service treats EITHER signal in window as inclusion.
    out.set(w.id, w)
  }
  return out
}

async function loadIntel(
  supabase: SupabaseClient,
  weddingIds: string[],
): Promise<Map<string, IntelRow>> {
  if (weddingIds.length === 0) return new Map()
  const out = new Map<string, IntelRow>()
  for (const batch of chunk(weddingIds, ID_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('couple_intel')
      .select(
        'wedding_id, intel, predicted_close_probability_pct, persona_label, last_derived_at',
      )
      .in('wedding_id', batch)

    if (error) {
      // Couple-intel is optional for rollup. If the load fails we just
      // run with profile-only data.
      console.warn('[cohort-rollup] loadIntel failed:', error.message)
      return new Map()
    }
    for (const row of (data ?? []) as IntelRow[]) {
      out.set(row.wedding_id, row)
    }
  }
  return out
}

async function loadLastInbound(
  supabase: SupabaseClient,
  weddingIds: string[],
  windowStartIso: string,
): Promise<Map<string, string>> {
  if (weddingIds.length === 0) return new Map()
  const out = new Map<string, string>()
  for (const batch of chunk(weddingIds, ID_BATCH_SIZE)) {
    const { data, error } = await supabase
      .from('interactions')
      .select('wedding_id, direction, timestamp')
      .in('wedding_id', batch)
      .eq('direction', 'inbound')
      .gte('timestamp', windowStartIso)
      .order('timestamp', { ascending: false })
      .limit(2000)

    if (error) {
      console.warn('[cohort-rollup] loadLastInbound failed:', error.message)
      return new Map()
    }
    for (const row of (data ?? []) as InteractionRow[]) {
      if (!row.wedding_id || !row.timestamp) continue
      if (!out.has(row.wedding_id)) {
        out.set(row.wedding_id, row.timestamp)
      }
    }
  }
  return out
}

async function loadTotalCouplesInVenue(
  supabase: SupabaseClient,
  venueId: string,
): Promise<number> {
  const { count } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
  return count ?? 0
}

// ---------------------------------------------------------------------------
// Evidence assembly
// ---------------------------------------------------------------------------

function daysBetween(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}

function bumpCount(map: Record<string, number>, key: string | null | undefined): void {
  if (!key) return
  map[key] = (map[key] ?? 0) + 1
}

interface BuildEvidenceInput {
  venueId: string
  venueLabel: string | null
  windowDays: number
  windowStartIso: string
  windowEndIso: string
  totalCouplesInVenue: number
  profiles: ProfileRow[]
  weddings: Map<string, WeddingRow>
  intelMap: Map<string, IntelRow>
  lastInboundMap: Map<string, string>
}

function buildEvidence(input: BuildEvidenceInput): CohortRollupEvidence {
  const now = Date.now()
  const sensitivityCounts: Record<string, number> = {}
  const personaCounts: Record<string, number> = {}
  const sourceCounts: Record<string, number> = {}
  const statusCounts: Record<string, number> = {}

  // Filter to couples whose wedding row exists and isn't tombstoned.
  const usableProfiles = input.profiles.filter((p) => input.weddings.has(p.wedding_id))

  // Cap to MAX_COUPLES_IN_PROMPT for prompt budget. Sort by Wave 5A's
  // predicted close-prob desc when available so the most informative
  // couples land in the cap; fall back to last_reconstructed_at
  // freshness.
  usableProfiles.sort((a, b) => {
    const ai = input.intelMap.get(a.wedding_id)
    const bi = input.intelMap.get(b.wedding_id)
    const ap = ai?.predicted_close_probability_pct ?? -1
    const bp = bi?.predicted_close_probability_pct ?? -1
    if (bp !== ap) return bp - ap
    return Date.parse(b.last_reconstructed_at) - Date.parse(a.last_reconstructed_at)
  })

  const capped = usableProfiles.slice(0, MAX_COUPLES_IN_PROMPT)

  const couples: AnonymisedCoupleSummary[] = capped.map((p, idx) => {
    const wedding = input.weddings.get(p.wedding_id)!
    const intel = input.intelMap.get(p.wedding_id)
    const lastInbound = input.lastInboundMap.get(p.wedding_id) ?? null

    const { nonSensitive, sensitiveCategories } = partitionThemes(
      p.profile.emotional_truths ?? [],
    )

    // Roll into cohort-shape counters (count each cohort member once
    // per category).
    for (const cat of new Set(sensitiveCategories)) {
      bumpCount(sensitivityCounts, cat)
    }
    if (intel?.persona_label) bumpCount(personaCounts, intel.persona_label)
    bumpCount(sourceCounts, wedding.source)
    bumpCount(statusCounts, wedding.status)

    const vendorPreferences = (p.profile.vendor_preferences ?? [])
      .slice(0, MAX_LIST_ITEMS)
      .map((v) => `${v.vendor_type}: ${v.preference}`)

    const culturalSignals = (p.profile.cultural_signals ?? [])
      .slice(0, MAX_LIST_ITEMS)
      .map((c) => c.signal)

    const accessibilityNeeds = (p.profile.accessibility_needs ?? [])
      .slice(0, MAX_LIST_ITEMS)
      .map((a) => a.need)

    const briefExcerpt = intel?.intel.coordinator_brief
      ? intel.intel.coordinator_brief.slice(0, MAX_COORDINATOR_BRIEF_CHARS)
      : null
    const recommendedAction = intel?.intel.recommended_next_action.action ?? null
    const staleAlerts = (intel?.intel.stale_signal_alerts ?? [])
      .slice(0, 3)
      .map((s) => `${s.signal} (${s.since})`)

    return {
      short_id: anonLabel(p.wedding_id, idx),
      persona_label: intel?.persona_label ?? '',
      predicted_close_pct: intel?.predicted_close_probability_pct ?? null,
      status: wedding.status,
      source: wedding.source,
      inquiry_date: wedding.inquiry_date,
      wedding_date: wedding.wedding_date,
      contract_signed: !!wedding.booked_at,
      last_inbound_at: lastInbound,
      days_since_inquiry: daysBetween(wedding.inquiry_date, now),
      days_since_last_inbound: daysBetween(lastInbound, now),
      non_sensitive_themes: nonSensitive,
      sensitive_theme_categories: Array.from(new Set(sensitiveCategories)),
      vendor_preferences: vendorPreferences,
      cultural_signals: culturalSignals,
      accessibility_needs: accessibilityNeeds,
      coordinator_brief_excerpt: briefExcerpt,
      recommended_action: recommendedAction,
      stale_alerts: staleAlerts,
    }
  })

  return {
    venueId: input.venueId,
    venueLabel: input.venueLabel,
    windowDays: input.windowDays,
    windowStartIso: input.windowStartIso,
    windowEndIso: input.windowEndIso,
    totalCouplesInVenue: input.totalCouplesInVenue,
    couplesInWindow: usableProfiles.length,
    sensitivityCounts,
    personaCounts,
    sourceCounts,
    statusCounts,
    couples,
  }
}

// ---------------------------------------------------------------------------
// Strip code fences (defensive — prompt asks the model to omit them)
// ---------------------------------------------------------------------------

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run a cohort rollup for one venue. One Sonnet call. Upserts into
 * venue_intel.
 *
 * Throws on:
 *   - venue not found
 *   - LLM call fails (callAI handles fallback; if both fail, callAI throws)
 *   - LLM response cannot be JSON-parsed or fails schema validation
 *
 * Returns ok with the rollup + cumulative cost when no couples are in
 * the window — produces an empty rollup with refusals annotating the
 * cohort gap. Some venues will be in this state at launch; better to
 * upsert the empty row so the dashboard shows a well-formed empty
 * state than to throw.
 */
export async function runCohortRollup(
  venueId: string,
  options: RunCohortRollupOptions = {},
): Promise<RunCohortRollupResult> {
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS

  const windowEndMs = Date.now()
  const windowStartMs = windowEndMs - windowDays * 86_400_000
  const windowStartIso = new Date(windowStartMs).toISOString()
  const windowEndIso = new Date(windowEndMs).toISOString()

  // Confirm venue exists.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('id, name')
    .eq('id', venueId)
    .maybeSingle()
  if (!venueRow) {
    throw new Error(`runCohortRollup: venue ${venueId} not found`)
  }
  const venueLabel = (venueRow as { name?: string } | null)?.name ?? null

  // Load profiles + total count in parallel.
  const [profiles, totalCouplesInVenue] = await Promise.all([
    loadProfilesForWindow(supabase, venueId, windowStartIso),
    loadTotalCouplesInVenue(supabase, venueId),
  ])

  const weddingIds = profiles.map((p) => p.wedding_id)
  const [weddings, intelMap, lastInboundMap] = await Promise.all([
    loadWeddings(supabase, weddingIds, windowStartIso),
    loadIntel(supabase, weddingIds),
    loadLastInbound(supabase, weddingIds, windowStartIso),
  ])

  const evidence = buildEvidence({
    venueId,
    venueLabel,
    windowDays,
    windowStartIso,
    windowEndIso,
    totalCouplesInVenue,
    profiles,
    weddings,
    intelMap,
    lastInboundMap,
  })

  const couplesInWindow = evidence.couplesInWindow

  // Empty-cohort fast path. Don't burn Sonnet on a venue with zero
  // window couples — emit a well-formed empty rollup with a refusal
  // annotating the gap so the dashboard can render the empty state
  // and the operator can see why.
  if (couplesInWindow === 0) {
    const emptyRollup: CohortRollupOutput = {
      emerging_themes: [],
      conversion_correlations: [],
      voice_calibration: [],
      service_demand_map: [],
      timing_patterns: [],
      refusals: [
        {
          field: 'all',
          reason:
            `no couples in last ${windowDays}d window for venue ${venueId}; ` +
            `total couples in venue=${totalCouplesInVenue}`,
        },
      ],
    }
    await upsertVenueIntel({
      supabase,
      venueId,
      rollup: emptyRollup,
      windowDays,
      couplesInWindow,
      newCallCostCents: 0,
    })
    return {
      rollup: emptyRollup,
      costCents: 0,
      promptVersion: COHORT_ROLLUP_PROMPT_VERSION,
      inputTokens: 0,
      outputTokens: 0,
      couplesInWindow,
      windowDays,
    }
  }

  // Build prompts.
  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(evidence)

  // Call Sonnet. Aggregator tier — temperature 0.3 (matches Wave 5A
  // synthesis). maxTokens 4000 because the output covers 5 sections.
  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'cohort_rollup',
    contentTier: 2,
    promptVersion: COHORT_ROLLUP_PROMPT_VERSION,
    venueId,
    maxTokens: 4000,
    temperature: 0.3,
    correlationId,
  })

  // Parse + validate.
  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `runCohortRollup: LLM returned non-JSON. parseError=${message} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const validation = validateCohortRollupOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `runCohortRollup: schema validation failed. error=${validation.error} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const rollup = validation.rollup

  const newCallCostCents = aiResult.cost * 100

  await upsertVenueIntel({
    supabase,
    venueId,
    rollup,
    windowDays,
    couplesInWindow,
    newCallCostCents,
  })

  return {
    rollup,
    costCents: newCallCostCents,
    promptVersion: COHORT_ROLLUP_PROMPT_VERSION,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
    couplesInWindow,
    windowDays,
  }
}

// ---------------------------------------------------------------------------
// Upsert + read
// ---------------------------------------------------------------------------

interface UpsertVenueIntelInput {
  supabase: SupabaseClient
  venueId: string
  rollup: CohortRollupOutput
  windowDays: number
  couplesInWindow: number
  /** Cost from THIS call in cents (added to the cumulative). */
  newCallCostCents: number
}

async function upsertVenueIntel(input: UpsertVenueIntelInput): Promise<void> {
  const { supabase, venueId, rollup, windowDays, couplesInWindow, newCallCostCents } =
    input

  // Read existing cumulative cost so the upsert accumulates rather
  // than overwrites.
  const { data: existing } = await supabase
    .from('venue_intel')
    .select('cost_cents')
    .eq('venue_id', venueId)
    .maybeSingle()

  const existingCostCents = existing
    ? Number((existing as { cost_cents: number | string }).cost_cents) || 0
    : 0
  const cumulativeCostCents = existingCostCents + newCallCostCents

  const upsertRow = {
    venue_id: venueId,
    rollup,
    last_refreshed_at: new Date().toISOString(),
    source_window_days: windowDays,
    couples_in_window: couplesInWindow,
    prompt_version: COHORT_ROLLUP_PROMPT_VERSION,
    cost_cents: cumulativeCostCents,
    updated_at: new Date().toISOString(),
  }

  const { error: upsertErr } = await supabase
    .from('venue_intel')
    .upsert(upsertRow, { onConflict: 'venue_id' })

  if (upsertErr) {
    throw new Error(`runCohortRollup: upsert failed: ${upsertErr.message}`)
  }
}

/**
 * Read the stored venue_intel row. Returns null when no row exists.
 * Used by GET /api/admin/intel/cohort-rollup and the
 * CohortRollupPanel + /intel/cohort dashboard.
 */
export interface StoredVenueIntel {
  venueId: string
  rollup: CohortRollupOutput
  lastRefreshedAt: string
  sourceWindowDays: number
  couplesInWindow: number
  promptVersion: string
  costCents: number
}

export async function getStoredVenueIntel(
  venueId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<StoredVenueIntel | null> {
  const supabase = options.supabase ?? createServiceClient()
  const { data, error } = await supabase
    .from('venue_intel')
    .select(
      'venue_id, rollup, last_refreshed_at, source_window_days, couples_in_window, prompt_version, cost_cents',
    )
    .eq('venue_id', venueId)
    .maybeSingle()
  if (error) {
    console.warn('[cohort-rollup] getStoredVenueIntel failed:', error.message)
    return null
  }
  if (!data) return null
  const row = data as {
    venue_id: string
    rollup: CohortRollupOutput
    last_refreshed_at: string
    source_window_days: number
    couples_in_window: number
    prompt_version: string
    cost_cents: number | string
  }
  return {
    venueId: row.venue_id,
    rollup: row.rollup,
    lastRefreshedAt: row.last_refreshed_at,
    sourceWindowDays: row.source_window_days,
    couplesInWindow: row.couples_in_window,
    promptVersion: row.prompt_version,
    costCents: Number(row.cost_cents) || 0,
  }
}
