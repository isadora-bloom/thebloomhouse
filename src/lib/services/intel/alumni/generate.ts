/**
 * Bloom House — Wave 14 alumni-cohort generator.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; aggregate
 *     ≠ disclose: alumni cohorts NEVER name a specific couple)
 *   - bloom-data-integrity-sweep.md (the aggregate/disclose split is the
 *     data-protection contract)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be backed by a real callAI; alumni archetypes are a Sonnet
 *     synthesis, not a template lookup)
 *
 * What this service does
 * ----------------------
 * For one venue: read all booked weddings + their couple_identity_profile +
 * couple_intel + outcomes, build a de-identified summary set + aggregate
 * distributions, call Sonnet once to discover archetypes, validate, and
 * upsert one alumni_cohorts row per archetype (replacing any prior
 * archetypes for the same venue).
 *
 * Cost target: ~$0.10-$0.20 per venue refresh.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  buildSystemPrompt,
  buildUserPrompt,
  validateAlumniCohortOutput,
  ALUMNI_COHORT_PROMPT_VERSION,
  type AlumniCohortEvidence,
  type AlumniCoupleSummary,
  type AlumniCohortOutput,
} from '@/config/prompts/alumni-cohort'
import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'

// Re-export for callers
export {
  ALUMNI_COHORT_PROMPT_VERSION,
  type AlumniCohortOutput,
  type AlumniArchetype,
} from '@/config/prompts/alumni-cohort'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GenerateAlumniCohortsResult {
  output: AlumniCohortOutput
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
  archetypesUpserted: number
  bookedCoupleCount: number
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const MAX_COUPLES_FETCHED = 500

interface BookedWeddingRow {
  id: string
  venue_id: string
  inquiry_date: string | null
  booked_at: string | null
  source: string | null
  guest_count_estimate: number | null
  booking_value: number | null
}

interface ProfileRow {
  wedding_id: string
  profile: CoupleIdentityProfile
}

interface IntelRow {
  wedding_id: string
  persona_label: string | null
}

async function loadBookedWeddings(
  supabase: SupabaseClient,
  venueId: string,
): Promise<BookedWeddingRow[]> {
  // "Booked" = booked_at is not null. We DO NOT filter on status here
  // because some venues use "won"/"booked"/"signed_contract" inconsistently;
  // the booked_at timestamp is the load-bearing signal that survived
  // Phase B clean-up.
  const { data, error } = await supabase
    .from('weddings')
    .select(
      'id, venue_id, inquiry_date, booked_at, source, guest_count_estimate, booking_value',
    )
    .eq('venue_id', venueId)
    .not('booked_at', 'is', null)
    .is('merged_into_id', null)
    .order('booked_at', { ascending: false })
    .limit(MAX_COUPLES_FETCHED)
  if (error) {
    throw new Error(`generateAlumniCohorts.loadBookedWeddings failed: ${error.message}`)
  }
  return (data ?? []) as BookedWeddingRow[]
}

async function loadProfiles(
  supabase: SupabaseClient,
  weddingIds: string[],
): Promise<Map<string, CoupleIdentityProfile>> {
  if (weddingIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id, profile')
    .in('wedding_id', weddingIds)
  if (error) {
    console.warn('[alumni-generate] loadProfiles failed:', error.message)
    return new Map()
  }
  const map = new Map<string, CoupleIdentityProfile>()
  for (const r of (data ?? []) as ProfileRow[]) {
    map.set(r.wedding_id, r.profile)
  }
  return map
}

async function loadIntel(
  supabase: SupabaseClient,
  weddingIds: string[],
): Promise<Map<string, string | null>> {
  if (weddingIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('couple_intel')
    .select('wedding_id, persona_label')
    .in('wedding_id', weddingIds)
  if (error) {
    console.warn('[alumni-generate] loadIntel failed:', error.message)
    return new Map()
  }
  const map = new Map<string, string | null>()
  for (const r of (data ?? []) as IntelRow[]) {
    map.set(r.wedding_id, r.persona_label)
  }
  return map
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

// ---------------------------------------------------------------------------
// Build de-identified per-couple summaries + aggregates
// ---------------------------------------------------------------------------

function bucketize(value: number | null, buckets: Array<[number, string]>): string {
  if (value === null) return 'unknown'
  for (const [threshold, label] of buckets) {
    if (value <= threshold) return label
  }
  return buckets[buckets.length - 1]?.[1] ?? 'unknown'
}

function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null
  const ta = Date.parse(a)
  const tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return Math.max(0, Math.round((tb - ta) / 86_400_000))
}

function joinShortPhrase(parts: Array<string | null | undefined>): string | null {
  const filtered = parts.filter((p) => !!p && p.length > 0) as string[]
  if (filtered.length === 0) return null
  return filtered.join(' / ')
}

function buildEvidence(
  venueId: string,
  venueLabel: string | null,
  weddings: BookedWeddingRow[],
  profiles: Map<string, CoupleIdentityProfile>,
  intelMap: Map<string, string | null>,
): AlumniCohortEvidence {
  const couples: AlumniCoupleSummary[] = []
  const personaDist: Record<string, number> = {}
  const sourceDist: Record<string, number> = {}
  const daysBuckets: Record<string, number> = {}
  const valueBuckets: Record<string, number> = {}
  const guestBuckets: Record<string, number> = {}

  weddings.forEach((w, idx) => {
    const profile = profiles.get(w.id)
    const personaLabel = intelMap.get(w.id) ?? null
    const daysToBook = daysBetween(w.inquiry_date, w.booked_at)

    if (personaLabel) {
      personaDist[personaLabel] = (personaDist[personaLabel] ?? 0) + 1
    } else {
      personaDist['(no persona)'] = (personaDist['(no persona)'] ?? 0) + 1
    }
    const sourceLabel = w.source ?? '(unknown)'
    sourceDist[sourceLabel] = (sourceDist[sourceLabel] ?? 0) + 1
    daysBuckets[
      bucketize(daysToBook, [
        [7, '0-7d'],
        [30, '8-30d'],
        [90, '31-90d'],
        [180, '91-180d'],
        [365, '181-365d'],
        [9999, '365+d'],
      ])
    ] = (daysBuckets[
      bucketize(daysToBook, [
        [7, '0-7d'],
        [30, '8-30d'],
        [90, '31-90d'],
        [180, '91-180d'],
        [365, '181-365d'],
        [9999, '365+d'],
      ])
    ] ?? 0) + 1
    const valueLabel = bucketize(w.booking_value, [
      [500_000, '<$5k'],
      [1_000_000, '$5k-$10k'],
      [2_500_000, '$10k-$25k'],
      [5_000_000, '$25k-$50k'],
      [10_000_000, '$50k-$100k'],
      [Number.MAX_SAFE_INTEGER, '$100k+'],
    ])
    valueBuckets[valueLabel] = (valueBuckets[valueLabel] ?? 0) + 1
    const guestLabel = bucketize(w.guest_count_estimate, [
      [50, '0-50'],
      [100, '51-100'],
      [150, '101-150'],
      [250, '151-250'],
      [10_000, '250+'],
    ])
    guestBuckets[guestLabel] = (guestBuckets[guestLabel] ?? 0) + 1

    const emotionalThemes: string[] = []
    const occupations: string[] = []
    let residence: string | null = null
    const culturalLabels: string[] = []
    let decisionDynamics: string | null = null
    if (profile) {
      for (const t of profile.emotional_truths) {
        // Theme label only (no evidence quotes). Sensitive themes stay
        // as the literal theme string, which is operator-safe.
        emotionalThemes.push(t.theme)
      }
      for (const o of profile.occupations) {
        occupations.push(o.occupation)
      }
      if (profile.residence) {
        const r = profile.residence
        residence = [r.city, r.state].filter(Boolean).join(', ') || null
      }
      for (const c of profile.cultural_signals) {
        culturalLabels.push(c.signal)
      }
      if (profile.decision_dynamics) {
        const d = profile.decision_dynamics
        decisionDynamics = joinShortPhrase([d.who_decides, d.who_questions, d.who_negotiates])
      }
    }

    couples.push({
      index: `couple_${String(idx + 1).padStart(3, '0')}`,
      persona_label: personaLabel,
      emotional_truth_themes: emotionalThemes,
      occupations,
      residence,
      cultural_signal_labels: culturalLabels,
      decision_dynamics: decisionDynamics,
      inquiry_source: w.source,
      days_to_book: daysToBook,
      guest_count: w.guest_count_estimate,
      booking_value_cents: w.booking_value,
    })
  })

  return {
    venueId,
    venueLabel,
    totalBookedCouples: weddings.length,
    couples,
    aggregates: {
      persona_distribution: personaDist,
      inquiry_source_distribution: sourceDist,
      days_to_book_buckets: daysBuckets,
      booking_value_buckets: valueBuckets,
      guest_count_buckets: guestBuckets,
    },
  }
}

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface GenerateAlumniCohortsOptions {
  supabase?: SupabaseClient
  correlationId?: string
}

/**
 * Generate alumni cohort archetypes for one venue. One Sonnet call.
 * Upserts alumni_cohorts rows — replaces all prior archetypes for the
 * venue with the fresh ones (delete-then-insert pattern, transactional
 * at the application layer).
 *
 * Throws on:
 *   - no booked weddings (caller should handle with a "no alumni data
 *     yet" UX state)
 *   - LLM failure (callAI throws if both Anthropic + OpenAI fail)
 *   - LLM response cannot be JSON-parsed or fails schema validation
 */
export async function generateAlumniCohorts(
  input: { venueId: string },
  options: GenerateAlumniCohortsOptions = {},
): Promise<GenerateAlumniCohortsResult> {
  const { venueId } = input
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId

  const weddings = await loadBookedWeddings(supabase, venueId)
  if (weddings.length === 0) {
    throw new Error(
      `generateAlumniCohorts: venue ${venueId} has no booked weddings — ` +
        `nothing to derive archetypes from`,
    )
  }
  const weddingIds = weddings.map((w) => w.id)
  const [profiles, intelMap, venueLabel] = await Promise.all([
    loadProfiles(supabase, weddingIds),
    loadIntel(supabase, weddingIds),
    loadVenueLabel(supabase, venueId),
  ])

  const evidence = buildEvidence(venueId, venueLabel, weddings, profiles, intelMap)

  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(evidence)

  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'alumni_cohort_generation',
    contentTier: 2,
    promptVersion: ALUMNI_COHORT_PROMPT_VERSION,
    venueId,
    maxTokens: 4000,
    temperature: 0.3,
    correlationId,
  })

  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `generateAlumniCohorts: LLM returned non-JSON. parseError=${message} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const validation = validateAlumniCohortOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `generateAlumniCohorts: schema validation failed. error=${validation.error} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const output = validation.output
  const costCents = aiResult.cost * 100

  // Replace prior archetypes for this venue with the fresh set. Best-
  // effort: if delete fails, we still attempt the insert (the new rows
  // accumulate). If insert fails, callers can re-run.
  try {
    await supabase.from('alumni_cohorts').delete().eq('venue_id', venueId)
  } catch (err) {
    console.warn(
      '[alumni-generate] delete-prior failed (non-fatal):',
      err instanceof Error ? err.message : err,
    )
  }

  let upserted = 0
  for (const archetype of output.archetypes) {
    const insertRow = {
      venue_id: venueId,
      archetype_label: archetype.label,
      archetype_description: archetype.description,
      booked_couple_count: archetype.booked_count,
      conversion_signature: archetype.conversion_signature,
      persona_distribution: Object.fromEntries(
        archetype.representative_persona_labels.map((label) => [
          label,
          evidence.aggregates.persona_distribution[label] ?? 0,
        ]),
      ),
      voice_principles: archetype.voice_principles,
      outcome_summary: archetype.outcome_summary,
      refreshed_at: new Date().toISOString(),
      prompt_version: ALUMNI_COHORT_PROMPT_VERSION,
      cost_cents: costCents / Math.max(1, output.archetypes.length),
    }
    const { error: insErr } = await supabase.from('alumni_cohorts').insert(insertRow)
    if (insErr) {
      console.warn(
        '[alumni-generate] insert failed for archetype',
        archetype.label,
        ':',
        insErr.message,
      )
    } else {
      upserted += 1
    }
  }

  return {
    output,
    costCents,
    promptVersion: ALUMNI_COHORT_PROMPT_VERSION,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
    archetypesUpserted: upserted,
    bookedCoupleCount: weddings.length,
  }
}

// ---------------------------------------------------------------------------
// Reader — list archetypes for a venue
// ---------------------------------------------------------------------------

export interface StoredAlumniArchetype {
  id: string
  venueId: string
  archetypeLabel: string
  archetypeDescription: string
  bookedCoupleCount: number
  conversionSignature: Record<string, unknown>
  personaDistribution: Record<string, number>
  voicePrinciples: string[]
  outcomeSummary: Record<string, unknown>
  refreshedAt: string
  promptVersion: string
  costCents: number
}

export async function listAlumniCohorts(
  venueId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<StoredAlumniArchetype[]> {
  const supabase = options.supabase ?? createServiceClient()
  const { data, error } = await supabase
    .from('alumni_cohorts')
    .select(
      'id, venue_id, archetype_label, archetype_description, booked_couple_count, conversion_signature, persona_distribution, voice_principles, outcome_summary, refreshed_at, prompt_version, cost_cents',
    )
    .eq('venue_id', venueId)
    .order('booked_couple_count', { ascending: false })
  if (error) {
    console.warn('[alumni-list] failed:', error.message)
    return []
  }
  return ((data ?? []) as Array<{
    id: string
    venue_id: string
    archetype_label: string
    archetype_description: string
    booked_couple_count: number
    conversion_signature: Record<string, unknown>
    persona_distribution: Record<string, number>
    voice_principles: unknown
    outcome_summary: Record<string, unknown>
    refreshed_at: string
    prompt_version: string
    cost_cents: number | string
  }>).map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    archetypeLabel: r.archetype_label,
    archetypeDescription: r.archetype_description,
    bookedCoupleCount: r.booked_couple_count,
    conversionSignature: r.conversion_signature ?? {},
    personaDistribution: r.persona_distribution ?? {},
    voicePrinciples: Array.isArray(r.voice_principles) ? (r.voice_principles as string[]) : [],
    outcomeSummary: r.outcome_summary ?? {},
    refreshedAt: r.refreshed_at,
    promptVersion: r.prompt_version,
    costCents: Number(r.cost_cents) || 0,
  }))
}
