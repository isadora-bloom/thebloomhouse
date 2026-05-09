/**
 * Bloom House: Continuous Profile-Enrichment Service
 *
 * 2026-05-09 Isadora directive:
 *   "this looking for the most complete information and updating per
 *   client should be a continuous thing - the profile should always be
 *   growing and updating on every contact. there should also be a notes
 *   section for the AI to pull relevant information into a general notes
 *   bucket so Sage and the coordinator can look at things - like if they
 *   mention in an email they had a stressful job interview etc"
 *
 * Why this file exists
 * --------------------
 * The Bloom Constitution frames Bloom as a forensic identity-
 * reconstruction system. Names are already covered by name-upgrade.ts
 * (sister service). This service handles the BROADER profile fields
 * PLUS the new soft-context note layer:
 *
 *   1. Structured signals — fields that map cleanly to schema columns
 *      (people.phone, people.employer, people.hometown,
 *      weddings.guest_count_estimate, weddings.dietary_summary,
 *      weddings.family_context). Only updates when strictly better:
 *      existing was NULL, candidate is longer/more-recent, or candidate
 *      agrees with existing for verifiable fields. Never overwrites
 *      coordinator-typed values (tracked via field_source jsonb).
 *
 *   2. Soft signals — life context, mood, pressures, vendor
 *      preferences, family dynamics, dietary mentions, cultural-
 *      significance asks, stressful job mentions, health context. These
 *      do NOT map cleanly to a column. They append to wedding_auto_context
 *      with a category tag, source = 'ai_email_extraction' (or
 *      'ai_calculator_extraction' / 'ai_brain_dump' / 'ai_tour_transcript'),
 *      and a 0-100 confidence score.
 *
 * Coordination with the identity stack
 * ------------------------------------
 * - name-upgrade.ts: sister service that owns first_name + last_name. We
 *   call upgradePeopleNameFromTouchpoints from inside this service when
 *   the structured-extraction stream produced a full name candidate, so
 *   the two flows stay in sync without each side double-writing.
 * - identity/resolver.ts: merges DIFFERENT people rows. We never trigger
 *   merges, we never touch tombstoned (`merged_into_id IS NOT NULL`)
 *   rows. We are a per-row enrichment, not a deduplication.
 * - body-extract.ts: stamps interactions.extracted_identity (regex-based,
 *   structural). We layer an LLM extraction on top of THAT signal +
 *   recent full_body to capture soft context the regex never sees.
 *
 * Cost discipline
 * ---------------
 * Every Claude call gates on cost-ceiling (gateForBrainCall). Tier:
 * sonnet (we need narrative comprehension to find soft signals; haiku
 * misses ambiguity). Content tier: 1 (email body + family context
 * counts as PII). Cap recent interactions at 30 to keep prompt small.
 * promptVersion: 'profile-enrichment.v1'. Sister service for
 * profile_enrichment task type in api_costs aggregation.
 *
 * Coordinator override invariants
 * -------------------------------
 * - field_source['xyz'] === 'coordinator_typed' → never write that key
 * - existing wedding_auto_context body already exists (90% Jaro-Winkler
 *   match) within last 90 days → increment confidence, don't insert
 * - archived/inactive auto_context rows are NOT counted in dedup
 *   (coordinator deliberately removed; respect the removal)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { upgradePeopleNameFromTouchpoints } from './name-upgrade'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const PROFILE_ENRICHMENT_PROMPT_VERSION = 'profile-enrichment.v1'

export type EnrichmentTrigger =
  | 'pipeline_email'
  | 'brain_dump_confirm'
  | 'tour_transcript'
  | 'admin_backfill'
  | 'manual_run'

export interface ProfileEnrichmentResult {
  weddingId: string
  fieldsUpdated: Array<{
    table: 'people' | 'weddings'
    rowId: string
    field: string
    from: unknown
    to: unknown
    source: string
    confidence: number
  }>
  notesAdded: Array<{
    body: string
    source: string
    categories: string[]
    confidence: number
    sourceInteractionId: string | null
  }>
  scanned: number
  /** True when the run was a no-op (cost ceiling tripped, wedding
   *  tombstoned, no usable signal). */
  skipped?: boolean
  skipReason?: string
}

export interface EnrichmentOptions {
  /** When true, compute candidates but do NOT write to people / weddings /
   *  wedding_auto_context. Returns the candidate set as-if. Used by the
   *  admin-backfill UI to show a coordinator what would change before
   *  green-lighting the bulk run. */
  dryRun?: boolean
  /** When set, only consider interactions with id > sinceInteractionId.
   *  The pipeline call uses this to avoid re-scanning the entire history
   *  on every email — the extracted_identity already covered the priors. */
  sinceInteractionId?: string | null
  /** What kicked this run; logged to profile_enrichment_runs.trigger. */
  trigger?: EnrichmentTrigger
  /** Optional correlation id (threaded through from the email pipeline). */
  correlationId?: string | null
  /** Override the supabase client (tests). */
  supabase?: SupabaseClient
}

// ---------------------------------------------------------------------------
// Internal types — what the LLM returns
// ---------------------------------------------------------------------------

interface RawAiResponse {
  structured?: {
    primary?: { phone?: string | null; employer?: string | null; hometown?: string | null }
    partner?: { phone?: string | null; employer?: string | null; hometown?: string | null; first_name?: string | null; last_name?: string | null }
    wedding?: {
      guest_count_estimate?: number | null
      dietary_summary?: string | null
      family_context?: string | null
    }
  }
  soft_signals?: Array<{
    body: string
    category?: string | null
    confidence?: number | null
  }>
}

interface PersonRow {
  id: string
  role: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  employer: string | null
  hometown: string | null
  profile_field_source: Record<string, string> | null
  merged_into_id: string | null
}

interface WeddingRow {
  id: string
  venue_id: string
  guest_count_estimate: number | null
  dietary_summary: string | null
  family_context: string | null
  field_source: Record<string, string> | null
  merged_into_id: string | null
  status: string | null
}

interface InteractionRow {
  id: string
  person_id: string | null
  from_email: string | null
  full_body: string | null
  body_preview: string | null
  subject: string | null
  extracted_identity: Record<string, unknown> | null
  timestamp: string | null
}

// ---------------------------------------------------------------------------
// Pure helpers (no I/O — testable)
// ---------------------------------------------------------------------------

/** Normalize a US-style phone for comparison. Returns digits only. */
function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null
  const digits = input.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 11) return null
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
}

/** Strict-better predicate for free-text fields. Candidate must be:
 *  - non-empty,
 *  - either: existing is null/empty, OR candidate is materially longer
 *    AND contains the existing as a substring (extension, not contradiction).
 *  Returns false on any conflict — coordinator-typed values are protected
 *  upstream by field_source check; this guards against AI replacing a
 *  longer existing with a shorter contradiction. */
function isStrictlyBetterText(
  existing: string | null,
  candidate: string | null | undefined,
): boolean {
  if (!candidate || !candidate.trim()) return false
  const c = candidate.trim()
  if (!existing || !existing.trim()) return true
  const e = existing.trim()
  if (e.toLowerCase() === c.toLowerCase()) return false
  // Pure extension — existing fully contained in candidate.
  if (c.toLowerCase().includes(e.toLowerCase()) && c.length > e.length) return true
  // Otherwise this is a different statement; refuse silently (coordinator
  // edits are the only path that should overwrite).
  return false
}

/** Strict-better predicate for guest count. Trust candidate when:
 *  - existing is null,
 *  - existing was a placeholder (<10 or >2000), or
 *  - candidate is within 30% of existing (refinement, not contradiction).
 *  Refuse otherwise — guest-count flips are coordinator-typed events. */
function isStrictlyBetterGuestCount(
  existing: number | null,
  candidate: number | null | undefined,
): boolean {
  if (candidate == null || !Number.isFinite(candidate)) return false
  if (candidate <= 0 || candidate > 5000) return false
  if (existing == null || existing <= 0) return true
  // Placeholder cleanup
  if (existing < 10 || existing > 2000) return true
  const ratio = Math.abs(candidate - existing) / existing
  return ratio <= 0.3 && candidate !== existing
}

/** Jaro-Winkler similarity (0-1). Used for the wedding_auto_context dedup
 *  contract. Implemented inline (vs adding a dependency) — string lengths
 *  are short, allocation is fine. Standard implementation. */
function jaroWinkler(s1: string, s2: string): number {
  if (s1 === s2) return 1
  if (s1.length === 0 || s2.length === 0) return 0
  const matchDistance = Math.max(0, Math.floor(Math.max(s1.length, s2.length) / 2) - 1)
  const s1Matches: boolean[] = new Array(s1.length).fill(false)
  const s2Matches: boolean[] = new Array(s2.length).fill(false)
  let matches = 0
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchDistance)
    const end = Math.min(i + matchDistance + 1, s2.length)
    for (let j = start; j < end; j++) {
      if (s2Matches[j]) continue
      if (s1[i] !== s2[j]) continue
      s1Matches[i] = true
      s2Matches[j] = true
      matches++
      break
    }
  }
  if (matches === 0) return 0
  let transpositions = 0
  let k = 0
  for (let i = 0; i < s1.length; i++) {
    if (!s1Matches[i]) continue
    while (!s2Matches[k]) k++
    if (s1[i] !== s2[k]) transpositions++
    k++
  }
  const m = matches
  const jaro = (m / s1.length + m / s2.length + (m - transpositions / 2) / m) / 3
  // Winkler boost — common prefix up to 4 chars.
  let prefix = 0
  for (let i = 0; i < Math.min(4, s1.length, s2.length); i++) {
    if (s1[i] === s2[i]) prefix++
    else break
  }
  return jaro + prefix * 0.1 * (1 - jaro)
}

/** 90%+ Jaro-Winkler match against an existing note body. Case- and
 *  whitespace-insensitive. */
function looselyMatchesExisting(candidate: string, existing: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
  return jaroWinkler(norm(candidate), norm(existing)) >= 0.9
}

const VALID_CATEGORIES = new Set([
  'life_context',
  'family',
  'vendors',
  'budget',
  'health',
  'dietary',
  'timeline',
  'cultural',
  'preferences',
  'logistics',
  'misc',
])

function normaliseCategory(input: string | null | undefined): string {
  if (!input) return 'misc'
  const c = input.trim().toLowerCase().replace(/[^a-z_]/g, '')
  return VALID_CATEGORIES.has(c) ? c : 'misc'
}

function clampConfidence(input: number | null | undefined): number {
  if (input == null || !Number.isFinite(input)) return 50
  return Math.max(0, Math.min(100, Math.round(input)))
}

// ---------------------------------------------------------------------------
// Internal helpers — DB access
// ---------------------------------------------------------------------------

interface EnrichmentInputs {
  wedding: WeddingRow
  people: PersonRow[]
  recentInteractions: InteractionRow[]
  existingActiveNotes: Array<{ body: string }>
}

async function loadEnrichmentInputs(
  supabase: SupabaseClient,
  weddingId: string,
  sinceInteractionId: string | null,
): Promise<EnrichmentInputs | null> {
  const { data: weddingRow, error: weddingErr } = await supabase
    .from('weddings')
    .select(
      'id, venue_id, guest_count_estimate, dietary_summary, family_context, field_source, merged_into_id, status',
    )
    .eq('id', weddingId)
    .maybeSingle()
  if (weddingErr || !weddingRow) return null
  const wedding = weddingRow as WeddingRow
  if (wedding.merged_into_id) return null

  const { data: peopleRows } = await supabase
    .from('people')
    .select(
      'id, role, first_name, last_name, email, phone, employer, hometown, profile_field_source, merged_into_id',
    )
    .eq('wedding_id', weddingId)
    .is('merged_into_id', null)
  const people = (peopleRows ?? []) as PersonRow[]

  // Cap recent interactions at 30 (per the brief). When sinceInteractionId
  // is set we still bound to 30 — defensive against bursts.
  let interactionsQuery = supabase
    .from('interactions')
    .select('id, person_id, from_email, full_body, body_preview, subject, extracted_identity, timestamp')
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: false })
    .limit(30)
  if (sinceInteractionId) {
    interactionsQuery = interactionsQuery.gt('id', sinceInteractionId)
  }
  const { data: interactionRows } = await interactionsQuery
  const recentInteractions = (interactionRows ?? []) as InteractionRow[]

  const { data: noteRows } = await supabase
    .from('wedding_auto_context')
    .select('body')
    .eq('wedding_id', weddingId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(200)
  const existingActiveNotes = (noteRows ?? []) as Array<{ body: string }>

  return { wedding, people, recentInteractions, existingActiveNotes }
}

interface BuildPromptArgs {
  wedding: WeddingRow
  people: PersonRow[]
  recentInteractions: InteractionRow[]
}

function buildPrompt(args: BuildPromptArgs): { system: string; user: string } {
  const { wedding, people, recentInteractions } = args

  const primary = people.find((p) => p.role === 'partner1') ?? people[0]
  const partner = people.find((p) => p.role === 'partner2') ?? people[1]

  const profileSummary = [
    primary
      ? `primary: ${primary.first_name ?? '?'} ${primary.last_name ?? '?'} | email=${primary.email ?? '?'} | phone=${primary.phone ?? '?'} | employer=${primary.employer ?? '?'} | hometown=${primary.hometown ?? '?'}`
      : 'primary: (none yet)',
    partner
      ? `partner: ${partner.first_name ?? '?'} ${partner.last_name ?? '?'} | email=${partner.email ?? '?'} | phone=${partner.phone ?? '?'} | employer=${partner.employer ?? '?'} | hometown=${partner.hometown ?? '?'}`
      : 'partner: (none yet)',
    `wedding: guest_count=${wedding.guest_count_estimate ?? '?'} | dietary=${wedding.dietary_summary ?? '?'} | family=${wedding.family_context ?? '?'} | status=${wedding.status ?? '?'}`,
  ].join('\n')

  // We only feed the model body slices — not whole gmail history. Cap
  // each interaction at 1500 chars (~300 tokens). 30 × 1500 = 45k chars
  // ≈ 10k tokens. Comfortable.
  const interactionText = recentInteractions
    .slice()
    .reverse() // chronological for the model
    .map((i, idx) => {
      const body = (i.full_body ?? i.body_preview ?? '').slice(0, 1500)
      const ts = i.timestamp ? new Date(i.timestamp).toISOString().slice(0, 10) : '?'
      const from = i.from_email ?? '?'
      const subj = i.subject ?? '(no subject)'
      return `--- INTERACTION ${idx + 1} (${ts}) from=${from}\nSubject: ${subj}\n${body}`
    })
    .join('\n\n')

  const system = `You are a forensic profile-enrichment extractor for a wedding venue intelligence system.

Read the existing couple profile + recent emails/transcripts and return ONLY a single JSON object with two streams:

1. structured: cleanly typed fields the database can store. Only include a field when you are CONFIDENT (>=70). Schema:
   {
     "primary": { "phone": string|null, "employer": string|null, "hometown": string|null },
     "partner": { "phone": string|null, "employer": string|null, "hometown": string|null, "first_name": string|null, "last_name": string|null },
     "wedding": { "guest_count_estimate": number|null, "dietary_summary": string|null, "family_context": string|null }
   }
   Rules:
   - Omit any field you cannot confidently extract.
   - Phone: only US-style, must contain at least 10 digits visible in the body.
   - guest_count_estimate: only when the couple says a number themselves ("we're thinking 100 guests") — never platform-suggested ranges.
   - dietary_summary: short coordinator-readable sentence ("3 vegetarians, 1 gluten-free").
   - family_context: short coordinator-readable note about family dynamics that affects planning ("groom's parents divorced, may need separated tables").

2. soft_signals: free-form observations that do NOT fit the schema columns but the coordinator + Sage would want to know. Examples: stressful job mentions, mood ("bride seemed anxious about timeline"), vendor preferences ("they want a live band, not DJ"), cultural traditions to honor, health context, family illness, travel plans that affect the wedding, references to other weddings they attended, anything that informs empathy. Schema:
   [{ "body": string, "category": string, "confidence": 0-100 }]
   Categories: life_context, family, vendors, budget, health, dietary, timeline, cultural, preferences, logistics, misc.
   Rules:
   - Each body is 1 short sentence in third person. Past tense when describing what they said. Quote nothing verbatim.
   - DO NOT repeat structured-stream fields as soft signals.
   - DO NOT invent — if the source text doesn't say it, don't write it.
   - Skip everything that's already adequately captured by the existing profile or notes (assume the coordinator has read them).
   - Limit to 6 most-important soft signals per call.

Return JSON only. No prose, no markdown.`

  const user = `EXISTING PROFILE:
${profileSummary}

RECENT INTERACTIONS (most recent first in storage; oldest-to-newest below):

${interactionText || '(no recent interactions)'}`

  return { system, user }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function enrichProfileFromTouchpoints(
  weddingId: string,
  options: EnrichmentOptions = {},
): Promise<ProfileEnrichmentResult> {
  const supabase = options.supabase ?? createServiceClient()
  const trigger = options.trigger ?? 'manual_run'
  const dryRun = options.dryRun === true
  const correlationId = options.correlationId ?? null
  const result: ProfileEnrichmentResult = {
    weddingId,
    fieldsUpdated: [],
    notesAdded: [],
    scanned: 0,
  }

  if (!weddingId) {
    return { ...result, skipped: true, skipReason: 'missing_wedding_id' }
  }

  let inputs: EnrichmentInputs | null
  try {
    inputs = await loadEnrichmentInputs(supabase, weddingId, options.sinceInteractionId ?? null)
  } catch (err) {
    console.warn('[profile-enrichment] load inputs failed:', redactError(err))
    return { ...result, skipped: true, skipReason: 'load_failed' }
  }
  if (!inputs) return { ...result, skipped: true, skipReason: 'wedding_missing_or_tombstoned' }

  const { wedding, people, recentInteractions, existingActiveNotes } = inputs
  result.scanned = recentInteractions.length

  // Nothing to learn from? Skip the LLM call.
  if (recentInteractions.length === 0) {
    return { ...result, skipped: true, skipReason: 'no_recent_interactions' }
  }

  // Cost-ceiling gate per Playbook OPS-21.4.3. Skip enrichment when the
  // venue is paused — it's an autonomous best-effort path. Coordinator-
  // initiated runs (admin backfill) intentionally bypass via a separate
  // override surface upstream.
  const venueId = wedding.venue_id
  const gate = await gateForBrainCall(venueId)
  if (!gate.ok) {
    return { ...result, skipped: true, skipReason: gate.reason }
  }

  // Build prompt.
  const { system, user } = buildPrompt({ wedding, people, recentInteractions })

  // Call the model. Tier-1 PII (family-context bodies). Sonnet for nuance.
  let parsed: RawAiResponse
  try {
    parsed = await callAIJson<RawAiResponse>({
      systemPrompt: system,
      userPrompt: user,
      maxTokens: 1200,
      temperature: 0.2,
      venueId,
      taskType: 'profile_enrichment',
      contentTier: 1,
      tier: 'sonnet',
      promptVersion: PROFILE_ENRICHMENT_PROMPT_VERSION,
      correlationId: correlationId ?? undefined,
    })
  } catch (err) {
    console.warn('[profile-enrichment] AI call failed:', redactError(err))
    // Persist a telemetry row so the coordinator dashboard can show the
    // failure without blocking the caller.
    await persistRunLog(supabase, {
      venueId,
      weddingId,
      trigger,
      fieldsUpdated: 0,
      notesAdded: 0,
      scanned: result.scanned,
      correlationId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { ...result, skipped: true, skipReason: 'ai_failed' }
  }

  // ---- Apply structured fields. -------------------------------------------
  const fieldUpdates = await applyStructuredUpdates({
    supabase,
    wedding,
    people,
    parsed,
    dryRun,
  })
  result.fieldsUpdated.push(...fieldUpdates)

  // ---- Apply soft-signal notes (with dedup contract). ----------------------
  const noteAppends = await applySoftSignals({
    supabase,
    wedding,
    parsed,
    existingActiveNotes,
    sourceForTrigger: triggerToNoteSource(trigger),
    sourceInteractionId: latestInteractionId(recentInteractions),
    dryRun,
  })
  result.notesAdded.push(...noteAppends)

  // ---- Cooperate with name-upgrade for partner names. ----------------------
  // Sister service owns first_name/last_name. We don't write names directly;
  // we just trigger its run so any new name signals in the recent emails get
  // promoted onto the people row.
  if (!dryRun) {
    try {
      await upgradePeopleNameFromTouchpoints(weddingId, { supabase })
    } catch (err) {
      console.warn('[profile-enrichment] name-upgrade follow-up failed:', err instanceof Error ? err.message : err)
    }
  }

  // ---- Telemetry. ----------------------------------------------------------
  await persistRunLog(supabase, {
    venueId,
    weddingId,
    trigger,
    fieldsUpdated: result.fieldsUpdated.length,
    notesAdded: result.notesAdded.length,
    scanned: result.scanned,
    correlationId,
  })

  return result
}

// ---------------------------------------------------------------------------
// Apply structured updates
// ---------------------------------------------------------------------------

async function applyStructuredUpdates(args: {
  supabase: SupabaseClient
  wedding: WeddingRow
  people: PersonRow[]
  parsed: RawAiResponse
  dryRun: boolean
}): Promise<ProfileEnrichmentResult['fieldsUpdated']> {
  const { supabase, wedding, people, parsed, dryRun } = args
  const updates: ProfileEnrichmentResult['fieldsUpdated'] = []
  const structured = parsed.structured ?? {}

  // ---- Wedding-level fields. ----------------------------------------------
  const wfs = (wedding.field_source ?? {}) as Record<string, string>
  const weddingPatch: Record<string, unknown> = {}
  const weddingFieldSourcePatch: Record<string, string> = {}

  if (
    structured.wedding?.guest_count_estimate != null &&
    wfs['guest_count_estimate'] !== 'coordinator_typed' &&
    isStrictlyBetterGuestCount(wedding.guest_count_estimate, structured.wedding.guest_count_estimate)
  ) {
    weddingPatch.guest_count_estimate = structured.wedding.guest_count_estimate
    weddingFieldSourcePatch.guest_count_estimate = 'extracted_email'
    updates.push({
      table: 'weddings',
      rowId: wedding.id,
      field: 'guest_count_estimate',
      from: wedding.guest_count_estimate,
      to: structured.wedding.guest_count_estimate,
      source: 'extracted_email',
      confidence: 80,
    })
  }

  if (
    structured.wedding?.dietary_summary &&
    wfs['dietary_summary'] !== 'coordinator_typed' &&
    isStrictlyBetterText(wedding.dietary_summary, structured.wedding.dietary_summary)
  ) {
    weddingPatch.dietary_summary = structured.wedding.dietary_summary.trim().slice(0, 500)
    weddingFieldSourcePatch.dietary_summary = 'extracted_email'
    updates.push({
      table: 'weddings',
      rowId: wedding.id,
      field: 'dietary_summary',
      from: wedding.dietary_summary,
      to: weddingPatch.dietary_summary,
      source: 'extracted_email',
      confidence: 75,
    })
  }

  if (
    structured.wedding?.family_context &&
    wfs['family_context'] !== 'coordinator_typed' &&
    isStrictlyBetterText(wedding.family_context, structured.wedding.family_context)
  ) {
    weddingPatch.family_context = structured.wedding.family_context.trim().slice(0, 800)
    weddingFieldSourcePatch.family_context = 'extracted_email'
    updates.push({
      table: 'weddings',
      rowId: wedding.id,
      field: 'family_context',
      from: wedding.family_context,
      to: weddingPatch.family_context,
      source: 'extracted_email',
      confidence: 75,
    })
  }

  if (Object.keys(weddingPatch).length > 0 && !dryRun) {
    weddingPatch.field_source = { ...wfs, ...weddingFieldSourcePatch }
    const { error: wErr } = await supabase
      .from('weddings')
      .update(weddingPatch)
      .eq('id', wedding.id)
      .is('merged_into_id', null)
    if (wErr) {
      console.warn('[profile-enrichment] wedding update failed:', wErr.message)
    }
  }

  // ---- Per-person fields (primary + partner). ------------------------------
  const primary = people.find((p) => p.role === 'partner1') ?? people[0]
  const partner = people.find((p) => p.role === 'partner2') ?? people[1]

  await applyPersonPatch({
    supabase,
    person: primary,
    candidate: structured.primary,
    label: 'extracted_email',
    dryRun,
    updates,
  })
  await applyPersonPatch({
    supabase,
    person: partner,
    candidate: structured.partner,
    label: 'extracted_email',
    dryRun,
    updates,
  })

  return updates
}

async function applyPersonPatch(args: {
  supabase: SupabaseClient
  person: PersonRow | undefined
  candidate:
    | { phone?: string | null; employer?: string | null; hometown?: string | null; first_name?: string | null; last_name?: string | null }
    | undefined
  label: string
  dryRun: boolean
  updates: ProfileEnrichmentResult['fieldsUpdated']
}): Promise<void> {
  const { supabase, person, candidate, label, dryRun, updates } = args
  if (!person || !candidate) return
  const fs = (person.profile_field_source ?? {}) as Record<string, string>

  const patch: Record<string, unknown> = {}
  const fsPatch: Record<string, string> = {}

  // Phone — accept when normalized form differs and existing was null.
  if (candidate.phone && fs['phone'] !== 'coordinator_typed') {
    const candNorm = normalizePhone(candidate.phone)
    const existNorm = normalizePhone(person.phone)
    if (candNorm && !existNorm) {
      patch.phone = candNorm
      fsPatch.phone = label
      updates.push({
        table: 'people',
        rowId: person.id,
        field: 'phone',
        from: person.phone,
        to: candNorm,
        source: label,
        confidence: 80,
      })
    }
  }

  if (
    candidate.employer &&
    fs['employer'] !== 'coordinator_typed' &&
    isStrictlyBetterText(person.employer, candidate.employer)
  ) {
    patch.employer = candidate.employer.trim().slice(0, 200)
    fsPatch.employer = label
    updates.push({
      table: 'people',
      rowId: person.id,
      field: 'employer',
      from: person.employer,
      to: patch.employer,
      source: label,
      confidence: 70,
    })
  }

  if (
    candidate.hometown &&
    fs['hometown'] !== 'coordinator_typed' &&
    isStrictlyBetterText(person.hometown, candidate.hometown)
  ) {
    patch.hometown = candidate.hometown.trim().slice(0, 200)
    fsPatch.hometown = label
    updates.push({
      table: 'people',
      rowId: person.id,
      field: 'hometown',
      from: person.hometown,
      to: patch.hometown,
      source: label,
      confidence: 70,
    })
  }

  // Names: explicitly NOT written here. Sister service name-upgrade.ts owns
  // first_name/last_name. We trigger upgradePeopleNameFromTouchpoints after
  // the call; it picks up extracted_identity.names that were written by the
  // body extractor on the same email cycle.

  if (Object.keys(patch).length > 0 && !dryRun) {
    patch.profile_field_source = { ...fs, ...fsPatch }
    const { error } = await supabase
      .from('people')
      .update(patch)
      .eq('id', person.id)
      .is('merged_into_id', null)
    if (error) {
      console.warn('[profile-enrichment] people update failed:', error.message)
    }
  }
}

// ---------------------------------------------------------------------------
// Apply soft signals (with 90% Jaro-Winkler dedup)
// ---------------------------------------------------------------------------

async function applySoftSignals(args: {
  supabase: SupabaseClient
  wedding: WeddingRow
  parsed: RawAiResponse
  existingActiveNotes: Array<{ body: string }>
  sourceForTrigger: string
  sourceInteractionId: string | null
  dryRun: boolean
}): Promise<ProfileEnrichmentResult['notesAdded']> {
  const { supabase, wedding, parsed, existingActiveNotes, sourceForTrigger, sourceInteractionId, dryRun } = args
  const out: ProfileEnrichmentResult['notesAdded'] = []
  const signals = parsed.soft_signals ?? []
  if (!Array.isArray(signals) || signals.length === 0) return out

  // Cap to 6 per call (defence against runaway model output).
  const capped = signals.slice(0, 6)

  for (const s of capped) {
    const bodyRaw = typeof s?.body === 'string' ? s.body.trim() : ''
    if (!bodyRaw || bodyRaw.length < 6) continue
    if (bodyRaw.length > 400) continue // implausibly long → skip

    const category = normaliseCategory(s.category)
    const confidence = clampConfidence(s.confidence ?? null)

    // Dedup: 90%+ JW match against any existing active note.
    const hit = existingActiveNotes.find((n) => looselyMatchesExisting(bodyRaw, n.body))
    if (hit) {
      // Per the brief: increment confidence on the existing match instead
      // of inserting a duplicate. We do a best-effort UPDATE; if it fails,
      // we still don't insert.
      if (!dryRun) {
        try {
          // Find the most recent matching row (existingActiveNotes only has
          // body; refetch the row to bump confidence). Best-effort.
          const { data: matchRows } = await supabase
            .from('wedding_auto_context')
            .select('id, confidence')
            .eq('wedding_id', wedding.id)
            .eq('is_active', true)
            .eq('body', hit.body)
            .order('created_at', { ascending: false })
            .limit(1)
          const row = matchRows?.[0] as { id: string; confidence: number | null } | undefined
          if (row) {
            const next = Math.min(100, (row.confidence ?? 50) + 5)
            await supabase
              .from('wedding_auto_context')
              .update({ confidence: next })
              .eq('id', row.id)
          }
        } catch (err) {
          console.warn(
            '[profile-enrichment] confidence bump failed:',
            err instanceof Error ? err.message : err,
          )
        }
      }
      continue
    }

    if (!dryRun) {
      const { error: insErr } = await supabase.from('wedding_auto_context').insert({
        venue_id: wedding.venue_id,
        wedding_id: wedding.id,
        body: bodyRaw,
        category,
        source: sourceForTrigger,
        source_interaction_id: sourceInteractionId,
        confidence,
      })
      if (insErr) {
        console.warn('[profile-enrichment] auto_context insert failed:', insErr.message)
        continue
      }
    }

    out.push({
      body: bodyRaw,
      source: sourceForTrigger,
      categories: [category],
      confidence,
      sourceInteractionId,
    })
  }

  return out
}

// ---------------------------------------------------------------------------
// Telemetry helper
// ---------------------------------------------------------------------------

async function persistRunLog(
  supabase: SupabaseClient,
  args: {
    venueId: string
    weddingId: string
    trigger: EnrichmentTrigger
    fieldsUpdated: number
    notesAdded: number
    scanned: number
    correlationId?: string | null
    error?: string
  },
): Promise<void> {
  try {
    await supabase.from('profile_enrichment_runs').insert({
      venue_id: args.venueId,
      wedding_id: args.weddingId,
      trigger: args.trigger,
      fields_updated_count: args.fieldsUpdated,
      notes_added_count: args.notesAdded,
      scanned_count: args.scanned,
      prompt_version: PROFILE_ENRICHMENT_PROMPT_VERSION,
      correlation_id: args.correlationId ?? null,
      error: args.error ?? null,
    })
  } catch (err) {
    // Telemetry failures are silent — the caller's work is already done.
    console.warn('[profile-enrichment] run log insert failed:', err instanceof Error ? err.message : err)
  }
}

function triggerToNoteSource(t: EnrichmentTrigger): string {
  switch (t) {
    case 'tour_transcript':
      return 'ai_tour_transcript'
    case 'brain_dump_confirm':
      return 'ai_brain_dump'
    case 'admin_backfill':
    case 'manual_run':
    case 'pipeline_email':
    default:
      return 'ai_email_extraction'
  }
}

function latestInteractionId(rows: InteractionRow[]): string | null {
  // recentInteractions came back ordered DESC; the first element is newest.
  return rows[0]?.id ?? null
}

// ---------------------------------------------------------------------------
// Test exports
// ---------------------------------------------------------------------------

export const __test__ = {
  isStrictlyBetterText,
  isStrictlyBetterGuestCount,
  jaroWinkler,
  looselyMatchesExisting,
  normalizePhone,
  normaliseCategory,
  clampConfidence,
  buildPrompt,
}
