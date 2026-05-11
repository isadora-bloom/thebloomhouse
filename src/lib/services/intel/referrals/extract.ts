/**
 * Bloom House — Wave 14 referral-extraction service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; every
 *     populated claim has a verbatim evidence_quote)
 *   - bloom-wave4-identity-reconstruction.md (reconstruct.ts is sealed;
 *     Wave 14 is a SIBLING extractor that runs AFTER reconstruction
 *     completes — reads couple_identity_profile, never modifies it)
 *   - bloom-phase-b-decisions.md (attribution_events is the audit row
 *     per attribution decision; Wave 14 extends with referrer_wedding_id)
 *
 * What this service does
 * ----------------------
 * Given a wedding_id whose couple_identity_profile already exists,
 * gather the profile + recent interactions, feed into one Haiku call,
 * parse + validate, and return the structured referrer mentions. The
 * caller is responsible for resolving each mention against existing
 * weddings/people (see resolve.ts) and writing the attribution_event
 * audit rows.
 *
 * Cost target: ~$0.003 per wedding (Haiku, low temperature, narrow
 * extraction).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAI } from '@/lib/ai/client'
import {
  buildSystemPrompt,
  buildUserPrompt,
  validateReferralExtractionOutput,
  REFERRAL_EXTRACTOR_PROMPT_VERSION,
  type ReferralEvidence,
  type ReferralInteractionEvidence,
  type ReferralExtractionOutput,
} from '@/config/prompts/referral-extractor'
import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'

// Re-export so callers don't have to import from two places.
export {
  REFERRAL_EXTRACTOR_PROMPT_VERSION,
  type ReferralExtractionOutput,
  type ReferrerMention,
  type ReferrerRelationship,
} from '@/config/prompts/referral-extractor'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ExtractReferrersResult {
  output: ReferralExtractionOutput
  costCents: number
  promptVersion: string
  inputTokens: number
  outputTokens: number
  venueId: string
  sourceProfileAt: string
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

const MAX_INTERACTIONS_FETCHED = 20

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

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
    throw new Error(`extractReferrers.loadProfile failed: ${error.message}`)
  }
  return (data as ProfileRow | null) ?? null
}

async function loadRecentInteractions(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<InteractionRow[]> {
  // Most-recent-first window. Wave 14 cares about referral mentions in
  // the body — inbound + outbound both surface them (the couple might
  // mention "Maya recommended you" in their first email; the
  // coordinator might confirm "Maya's wedding was last June" in the
  // reply).
  const { data, error } = await supabase
    .from('interactions')
    .select(
      'id, direction, from_email, from_name, subject, full_body, body_preview, timestamp',
    )
    .eq('wedding_id', weddingId)
    .order('timestamp', { ascending: false })
    .limit(MAX_INTERACTIONS_FETCHED)
  if (error) {
    console.warn('[referral-extract] loadRecentInteractions failed:', error.message)
    return []
  }
  return (data ?? []) as InteractionRow[]
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

function buildInteractionEvidence(
  rows: InteractionRow[],
): ReferralInteractionEvidence[] {
  return rows.map((r, idx) => ({
    index: idx + 1,
    direction: (r.direction === 'outbound' ? 'outbound' : 'inbound') as
      | 'inbound'
      | 'outbound',
    from_email: r.from_email,
    from_name: r.from_name,
    subject: r.subject,
    body_excerpt: r.full_body ?? r.body_preview ?? null,
    timestamp: r.timestamp,
  }))
}

function stripJsonFences(text: string): string {
  return text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export interface ExtractReferrersOptions {
  /** Optional Supabase client override (tests). Defaults to service-role. */
  supabase?: SupabaseClient
  /** Optional correlation id (threaded into api_costs). */
  correlationId?: string
}

/**
 * Extract referrer mentions for a single wedding. One Haiku call.
 *
 * Throws on:
 *   - profile not reconstructed (Wave 4 must run first)
 *   - LLM call fails (callAI handles fallback; if both fail, callAI throws)
 *   - LLM response cannot be JSON-parsed or fails schema validation
 *
 * Does NOT write attribution_event rows. The caller (resolveReferrer)
 * decides whether each mention resolves to a real wedding or stays
 * deferred.
 */
export async function extractReferrers(
  input: { weddingId: string },
  options: ExtractReferrersOptions = {},
): Promise<ExtractReferrersResult> {
  const { weddingId } = input
  const supabase = options.supabase ?? createServiceClient()
  const correlationId = options.correlationId

  // 1. Profile must exist. Wave 4 (reconstruct.ts) must have run.
  const profileRow = await loadProfile(supabase, weddingId)
  if (!profileRow) {
    throw new Error(
      `extractReferrers: profile not yet reconstructed for wedding ${weddingId}; ` +
        `trigger /api/admin/identity/reconstruct first`,
    )
  }

  // 2. Recent interactions + venue label.
  const [interactions, venueLabel] = await Promise.all([
    loadRecentInteractions(supabase, weddingId),
    loadVenueLabel(supabase, profileRow.venue_id),
  ])

  // 3. Build prompts.
  const evidence: ReferralEvidence = {
    weddingId,
    venueLabel,
    profile: profileRow.profile,
    recentInteractions: buildInteractionEvidence(interactions),
  }
  const systemPrompt = buildSystemPrompt()
  const userPrompt = buildUserPrompt(evidence)

  // 4. Haiku call — extraction is narrow + cheap.
  const aiResult = await callAI({
    systemPrompt,
    userPrompt,
    tier: 'haiku',
    taskType: 'referral_extraction',
    contentTier: 2,
    promptVersion: REFERRAL_EXTRACTOR_PROMPT_VERSION,
    venueId: profileRow.venue_id,
    maxTokens: 1500,
    temperature: 0.1,
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
      `extractReferrers: LLM returned non-JSON. parseError=${message} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }
  const validation = validateReferralExtractionOutput(parsed)
  if (!validation.ok) {
    throw new Error(
      `extractReferrers: schema validation failed. error=${validation.error} ` +
        `rawResponse=${cleaned.slice(0, 2000)}`,
    )
  }

  return {
    output: validation.output,
    costCents: aiResult.cost * 100,
    promptVersion: REFERRAL_EXTRACTOR_PROMPT_VERSION,
    inputTokens: aiResult.inputTokens,
    outputTokens: aiResult.outputTokens,
    venueId: profileRow.venue_id,
    sourceProfileAt: profileRow.last_reconstructed_at,
  }
}
