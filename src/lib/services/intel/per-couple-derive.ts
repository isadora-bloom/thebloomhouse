/**
 * Bloom House — Wave 5A per-couple intel derive service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (Wave 5A is the action layer; voice-shape
 *     output, never quotes sensitive evidence verbatim)
 *   - bloom-wave4-5-6-master-plan.md (5A spec)
 *   - bloom-may9-llm-vs-template.md (every "AI / Sage / smart" surface
 *     must be a real callAI; this service is a Sonnet synthesizer)
 *
 * What this service does
 * ----------------------
 * Given a wedding_id with an existing couple_identity_profile row,
 * gather that profile + wedding shell + last 10 interactions + tour /
 * payment status, feed it into one Sonnet call, parse + validate, and
 * upsert into couple_intel.
 *
 * Different LLM job from Wave 4
 * -----------------------------
 * Wave 4 is forensic extraction. Wave 5A is synthesis: persona +
 * close-prob + recommended action + coordinator brief + sensitivity
 * flags + stale-signal alerts. Voice-shape paragraph + recommendations,
 * not evidence-quoted claims.
 *
 * Cost target: ~$0.02/derive (Sonnet, 3000 max output tokens, 24h
 * cache window). 671-couple bulk = ~$15.
 *
 * One LLM call per couple. Idempotent at the upsert layer.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  buildSystemPrompt,
  buildUserPrompt,
  validateCoupleIntelOutput,
  COUPLE_INTEL_DERIVE_PROMPT_VERSION,
  type CoupleIntelOutput,
  type CoupleIntelEvidence,
  type IntelInteractionEvidence,
  type IntelTourStatus,
  type IntelPaymentStatus,
  type IntelWeddingShell,
} from '@/config/prompts/couple-intel-derive'
import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'

// Re-export so callers don't have to import from two places.
export {
  COUPLE_INTEL_DERIVE_PROMPT_VERSION,
  type CoupleIntelOutput,
} from '@/config/prompts/couple-intel-derive'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeriveCoupleIntelResult {
  intel: CoupleIntelOutput
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
  deriveCount: number
  predictedCloseProbabilityPct: number
  personaLabel: string
  sourceProfileAt: string | null
}

// ---------------------------------------------------------------------------
// Evidence loaders
// ---------------------------------------------------------------------------

const MAX_INTERACTIONS_FETCHED = 10
const MAX_INTERACTION_BODY_CHARS = 1500

interface WeddingRow {
  id: string
  venue_id: string
  inquiry_date: string | null
  wedding_date: string | null
  status: string | null
  source: string | null
  guest_count_estimate: number | null
  booking_value: number | null
  notes: string | null
  booked_at: string | null
  merged_into_id: string | null
}

interface ProfileRow {
  wedding_id: string
  venue_id: string
  profile: CoupleIdentityProfile
  last_reconstructed_at: string
}

interface InteractionRow {
  id: string
  direction: string | null
  from_email: string | null
  from_name: string | null
  subject: string | null
  full_body: string | null
  body_preview: string | null
  timestamp: string | null
}

interface TourRow {
  id: string
  scheduled_at: string | null
  outcome: string | null
}

async function loadWedding(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<WeddingRow | null> {
  const { data, error } = await supabase
    .from('weddings')
    .select(
      'id, venue_id, inquiry_date, wedding_date, status, source, guest_count_estimate, booking_value, notes, booked_at, merged_into_id',
    )
    .eq('id', weddingId)
    .maybeSingle()
  if (error) {
    throw new Error(`derive.loadWedding failed: ${error.message}`)
  }
  return (data as WeddingRow | null) ?? null
}

async function loadProfile(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<ProfileRow | null> {
  const { data, error } = await supabase
    .from('couple_identity_profile')
    .select('wedding_id, venue_id, profile, last_reconstructed_at')
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (error) {
    throw new Error(`derive.loadProfile failed: ${error.message}`)
  }
  return (data as ProfileRow | null) ?? null
}

async function loadRecentInteractions(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<InteractionRow[]> {
  const { data, error } = await supabase
    .from('interactions')
    .select('id, direction, from_email, from_name, subject, full_body, body_preview, timestamp')
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: false })
    .limit(MAX_INTERACTIONS_FETCHED)
  if (error) {
    console.warn('[per-couple-derive] loadRecentInteractions failed:', error.message)
    return []
  }
  return (data ?? []) as InteractionRow[]
}

async function loadTour(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<TourRow | null> {
  // Pick the most-recent tour by scheduled_at. Many couples have no tour
  // row at all; that's the common path.
  const { data, error } = await supabase
    .from('tours')
    .select('id, scheduled_at, outcome')
    .eq('wedding_id', weddingId)
    .order('scheduled_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    // tours table absent / RLS blocked / schema drift — partial evidence
    // is fine. Return no tour.
    return null
  }
  return (data as TourRow | null) ?? null
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

function daysBetween(iso: string | null, now: number): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return null
  return Math.max(0, Math.floor((now - t) / 86_400_000))
}

function deriveLastInbound(rows: InteractionRow[]): string | null {
  // rows are most-recent-first; first inbound is newest.
  for (const r of rows) {
    if (r.direction === 'inbound' && r.timestamp) return r.timestamp
  }
  return null
}

function buildEvidenceShell(
  wedding: WeddingRow,
  rows: InteractionRow[],
  tour: TourRow | null,
): { shell: IntelWeddingShell; payment: IntelPaymentStatus; tourStatus: IntelTourStatus } {
  const now = Date.now()
  const lastInboundIso = deriveLastInbound(rows)
  const shell: IntelWeddingShell = {
    inquiry_date: wedding.inquiry_date,
    wedding_date: wedding.wedding_date,
    status: wedding.status,
    source: wedding.source,
    guest_count_estimate: wedding.guest_count_estimate,
    booking_value_cents: wedding.booking_value,
    notes: wedding.notes,
    days_since_inquiry: daysBetween(wedding.inquiry_date, now),
    days_since_last_inbound: daysBetween(lastInboundIso, now),
  }
  // Payment — this codebase tracks booking_value on weddings + booked_at
  // as the "contract signed" signal. There's no payments table, so we
  // synthesise a coarse status the model can reason about.
  const payment: IntelPaymentStatus = {
    total_paid_cents: 0,
    contract_signed: !!wedding.booked_at,
    last_payment_at: wedding.booked_at,
  }
  const tourStatus: IntelTourStatus = {
    has_tour: !!tour,
    scheduled_at: tour?.scheduled_at ?? null,
    outcome: tour?.outcome ?? null,
  }
  return { shell, payment, tourStatus }
}

function buildInteractionEvidence(rows: InteractionRow[]): IntelInteractionEvidence[] {
  // rows are most-recent-first from the loader. Index from 1 newest →
  // older. The prompt header says "most-recent-first" so the model
  // reads recency directly.
  return rows.map((r, idx) => ({
    index: idx + 1,
    direction: (r.direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
    from_email: r.from_email,
    from_name: r.from_name,
    subject: r.subject,
    body_excerpt:
      (r.full_body ?? r.body_preview ?? null)?.slice(0, MAX_INTERACTION_BODY_CHARS) ?? null,
    timestamp: r.timestamp,
  }))
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

export interface DeriveCoupleIntelOptions {
  /** Optional client override (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** Optional correlation id (threaded into api_costs.correlation_id). */
  correlationId?: string
}

/**
 * Derive per-couple intel for a single wedding. One Sonnet call. Upserts
 * into couple_intel.
 *
 * Throws on:
 *   - wedding not found
 *   - profile row missing (Wave 4 must run first)
 *   - LLM call fails (callAI handles fallback; if both fail, callAI throws)
 *   - LLM response cannot be JSON-parsed or fails schema validation
 */
export async function deriveCoupleIntel(
  weddingId: string,
  options: DeriveCoupleIntelOptions = {},
): Promise<DeriveCoupleIntelResult> {
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId

  // 1. Profile is required — Wave 4 must run first.
  const profileRow = await loadProfile(supabase, weddingId)
  if (!profileRow) {
    throw new Error(
      `deriveCoupleIntel: profile not yet reconstructed for wedding ${weddingId}; ` +
        `trigger /api/admin/identity/reconstruct first`,
    )
  }

  // 2. Load wedding + interactions + tour in parallel.
  const [wedding, interactions, tour, venueLabel] = await Promise.all([
    loadWedding(supabase, weddingId),
    loadRecentInteractions(supabase, weddingId),
    loadTour(supabase, weddingId),
    loadVenueLabel(supabase, profileRow.venue_id),
  ])
  if (!wedding) {
    throw new Error(`deriveCoupleIntel: wedding ${weddingId} not found`)
  }

  const venueId = profileRow.venue_id
  const sourceProfileAt = profileRow.last_reconstructed_at

  const { shell, payment, tourStatus } = buildEvidenceShell(wedding, interactions, tour)
  const interactionEvidence = buildInteractionEvidence(interactions)

  const evidence: CoupleIntelEvidence = {
    weddingId,
    venueLabel,
    weddingShell: shell,
    profile: profileRow.profile,
    recentInteractions: interactionEvidence,
    tour: tourStatus,
    payment,
  }

  // 3. Build prompts.
  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(evidence)

  // 4. Call Sonnet. Synthesis tier — slightly higher temperature than
  //    Wave 4's extraction (0.2) because the persona discovery + brief
  //    writing benefit from a touch of variance.
  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'sonnet',
    taskType: 'couple_intel_derive',
    contentTier: 2,
    promptVersion: COUPLE_INTEL_DERIVE_PROMPT_VERSION,
    venueId,
    maxTokens: 3000,
    temperature: 0.3,
    correlationId,
  })

  // 5. Parse + validate.
  const cleaned = stripJsonFences(aiResult.text)
  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch (parseErr) {
    const message = parseErr instanceof Error ? parseErr.message : String(parseErr)
    throw new Error(
      `deriveCoupleIntel: LLM returned non-JSON. parseError=${message} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const validation = validateCoupleIntelOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `deriveCoupleIntel: schema validation failed. error=${validation.error} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const intel = validation.intel

  // 6. Upsert. cost_cents accumulates across derives, so read the
  //    existing row's cumulative + add the new call's cost. derive_count
  //    increments by 1.
  const newCallCostCents = aiResult.cost * 100

  const { data: existing } = await supabase
    .from('couple_intel')
    .select('cost_cents, derive_count')
    .eq('wedding_id', weddingId)
    .maybeSingle()

  const existingCostCents = existing
    ? Number((existing as { cost_cents: number | string }).cost_cents) || 0
    : 0
  const existingCount = existing
    ? Number((existing as { derive_count: number }).derive_count) || 0
    : 0
  const cumulativeCostCents = existingCostCents + newCallCostCents
  const newCount = existing ? existingCount + 1 : 1

  const upsertRow = {
    wedding_id: weddingId,
    venue_id: venueId,
    intel,
    predicted_close_probability_pct: intel.predicted_close_probability.pct_0_100,
    persona_label: intel.persona.label,
    last_derived_at: new Date().toISOString(),
    source_profile_at: sourceProfileAt,
    derive_count: newCount,
    prompt_version: COUPLE_INTEL_DERIVE_PROMPT_VERSION,
    cost_cents: cumulativeCostCents,
  }

  const { error: upsertErr } = await supabase
    .from('couple_intel')
    .upsert(upsertRow, { onConflict: 'wedding_id' })

  if (upsertErr) {
    throw new Error(`deriveCoupleIntel: upsert failed: ${upsertErr.message}`)
  }

  // Wave 6A reconciliation (2026-05-10). After couple_intel updates,
  // refresh persona_overlay snapshots on this wedding's
  // attribution_events so spend ROI rollups (Wave 6B) can join through
  // a current persona. Fire-and-forget — never fail the derive on this.
  try {
    const { enqueuePersonaOverlayRefresh } = await import('@/lib/services/marketing-spend/persona-overlay')
    await enqueuePersonaOverlayRefresh({ weddingId, supabase })
  } catch (err) {
    console.warn('[deriveCoupleIntel] persona_overlay enqueue failed (non-fatal):', err instanceof Error ? err.message : err)
  }

  // Wave 18 calibration recording hook (2026-05-11). Snapshot the
  // prediction so analyze.ts can later compute Brier / reliability /
  // drift once the lifecycle reaches a terminal state. Fire-and-
  // forget — never fail the derive on this.
  try {
    const { recordPrediction } = await import('@/lib/services/calibration/record-prediction')
    await recordPrediction({
      weddingId,
      kind: 'close_probability_pct',
      value: intel.predicted_close_probability.pct_0_100,
      confidence: intel.predicted_close_probability.confidence_0_100,
      source: 'wave_5a_couple_intel',
      promptVersion: COUPLE_INTEL_DERIVE_PROMPT_VERSION,
      costCents: newCallCostCents,
      venueId,
      supabase,
    })
  } catch (err) {
    console.warn('[deriveCoupleIntel] calibration recordPrediction failed (non-fatal):', err instanceof Error ? err.message : err)
  }

  return {
    intel,
    costCents: newCallCostCents,
    promptVersion: COUPLE_INTEL_DERIVE_PROMPT_VERSION,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
    deriveCount: newCount,
    predictedCloseProbabilityPct: intel.predicted_close_probability.pct_0_100,
    personaLabel: intel.persona.label,
    sourceProfileAt,
  }
}

/**
 * Read the stored intel for a wedding. Returns null when no row exists.
 * Used by GET /api/admin/intel/couple-derive and CoupleIntelPanel.
 */
export interface StoredCoupleIntel {
  weddingId: string
  venueId: string
  intel: CoupleIntelOutput
  predictedCloseProbabilityPct: number | null
  personaLabel: string | null
  lastDerivedAt: string
  sourceProfileAt: string | null
  deriveCount: number
  promptVersion: string
  costCents: number
}

export async function getStoredCoupleIntel(
  weddingId: string,
  options: { supabase?: SupabaseClient } = {},
): Promise<StoredCoupleIntel | null> {
  const supabase = options.supabase ?? createServiceClient()
  const { data, error } = await supabase
    .from('couple_intel')
    .select(
      'wedding_id, venue_id, intel, predicted_close_probability_pct, persona_label, last_derived_at, source_profile_at, derive_count, prompt_version, cost_cents',
    )
    .eq('wedding_id', weddingId)
    .maybeSingle()
  if (error) {
    console.warn('[per-couple-derive] getStoredCoupleIntel failed:', error.message)
    return null
  }
  if (!data) return null
  const row = data as {
    wedding_id: string
    venue_id: string
    intel: CoupleIntelOutput
    predicted_close_probability_pct: number | null
    persona_label: string | null
    last_derived_at: string
    source_profile_at: string | null
    derive_count: number
    prompt_version: string
    cost_cents: number | string
  }
  return {
    weddingId: row.wedding_id,
    venueId: row.venue_id,
    intel: row.intel,
    predictedCloseProbabilityPct: row.predicted_close_probability_pct,
    personaLabel: row.persona_label,
    lastDerivedAt: row.last_derived_at,
    sourceProfileAt: row.source_profile_at,
    deriveCount: row.derive_count,
    promptVersion: row.prompt_version,
    costCents: Number(row.cost_cents) || 0,
  }
}
