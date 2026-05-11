/**
 * Bloom House — Wave 14 referral-resolver.
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; named
 *     referrer is a forensic claim about the new couple's social graph)
 *   - bloom-phase-b-decisions.md (attribution_events audit row pattern;
 *     deferred correlation for unmatched-but-named referrers)
 *   - bloom-may9-llm-vs-template.md (fuzzy matching uses deterministic
 *     normalization + the existing Wave 4 identity-resolution patterns;
 *     the LLM judges referral mentions, not name-match decisions)
 *
 * What this service does
 * ----------------------
 * Given a referrer mention (name + relationship + evidence_quote) and
 * a venue_id, search existing weddings + people for the named referrer
 * using fuzzy matching. Three outcomes:
 *
 *   1. **Tier 1 match** — clean single-candidate match (last + first
 *      name, or last name + state, or full-name fuzzy). Writes an
 *      attribution_event row with referrer_wedding_id linkage +
 *      evidence_quote. Returns { kind: 'matched' }.
 *
 *   2. **Tier 2 ambiguous** — two or more weddings match the referrer
 *      name. Writes an attribution_event row with referrer_name_text
 *      populated but referrer_wedding_id NULL — surfaces in the
 *      operator review queue with the ambiguous candidates listed.
 *      Returns { kind: 'ambiguous', candidateWeddingIds }.
 *
 *   3. **No match** — name does not match any existing wedding. Writes
 *      an attribution_event row with referrer_name_text populated and
 *      referrer_wedding_id NULL — future correlation can match when
 *      the named person enters the system. Returns { kind: 'deferred' }.
 *
 * Per memory/feedback_deep_fix_vs_bandaid.md, the LLM is the primitive
 * for extraction; the resolver is deterministic name normalization +
 * lookup. We do NOT auto-execute low-confidence (< 70%) referrer
 * linkages — those defer to operator review even when a single name
 * candidate emerges.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import type { ReferrerMention } from '@/config/prompts/referral-extractor'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolveReferrerInput {
  /** The wedding this referral applies TO (the new couple). */
  newWeddingId: string
  /** The venue scope. */
  venueId: string
  /** The mention extracted by the LLM. */
  mention: ReferrerMention
  /** Optional Supabase client override (tests). */
  supabase?: SupabaseClient
}

export type ResolveReferrerResult =
  | {
      kind: 'matched'
      attributionEventId: string
      referrerWeddingId: string
    }
  | {
      kind: 'ambiguous'
      attributionEventId: string
      candidateWeddingIds: string[]
    }
  | {
      kind: 'deferred'
      attributionEventId: string
    }
  | {
      kind: 'skipped'
      reason: string
    }

// ---------------------------------------------------------------------------
// Name normalisation
// ---------------------------------------------------------------------------

/**
 * Lower-case + strip punctuation + collapse whitespace. The same
 * shape the Wave 4 resolver uses for name comparison.
 */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function splitName(name: string): { first: string | null; last: string | null } {
  const norm = normalizeName(name)
  if (!norm) return { first: null, last: null }
  const parts = norm.split(' ')
  if (parts.length === 1) return { first: parts[0], last: null }
  return { first: parts[0], last: parts[parts.length - 1] }
}

// ---------------------------------------------------------------------------
// Match logic — venue-scoped, on weddings + people
// ---------------------------------------------------------------------------

interface PersonRow {
  id: string
  wedding_id: string | null
  first_name: string | null
  last_name: string | null
}

/**
 * Find candidate referrer weddings in the venue. Tier-1 match: exact
 * normalized first AND last name. Tier-2: exact normalized last name
 * only, OR exact normalized first name only when last is missing.
 *
 * Returns a deduplicated list of wedding_ids (no NULL rows — people
 * with no wedding_id are excluded; they can't be a referrer wedding).
 */
async function findCandidateReferrerWeddings(
  supabase: SupabaseClient,
  venueId: string,
  referrerName: string,
  excludeWeddingId: string,
): Promise<{ wedding_ids: string[]; tier: 'exact' | 'partial' | 'none' }> {
  const { first, last } = splitName(referrerName)
  if (!first && !last) {
    return { wedding_ids: [], tier: 'none' }
  }

  // Fetch all venue people in scope. Cap defensively at 2000 — venues
  // with more than 2000 historical people are rare and a coordinator-
  // review queue is appropriate at that scale.
  const { data, error } = await supabase
    .from('people')
    .select('id, wedding_id, first_name, last_name')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .not('wedding_id', 'is', null)
    .neq('wedding_id', excludeWeddingId)
    .limit(2000)
  if (error) {
    console.warn('[referral-resolve] people lookup failed:', error.message)
    return { wedding_ids: [], tier: 'none' }
  }
  const rows = (data ?? []) as PersonRow[]

  const exact = new Set<string>()
  const partial = new Set<string>()
  for (const r of rows) {
    if (!r.wedding_id) continue
    const f = r.first_name ? normalizeName(r.first_name) : null
    const l = r.last_name ? normalizeName(r.last_name) : null
    if (first && last && f === first && l === last) {
      exact.add(r.wedding_id)
      continue
    }
    if (last && l === last) {
      partial.add(r.wedding_id)
      continue
    }
    if (first && !last && f === first) {
      // First-name-only match (e.g. "Maya recommended you" → match
      // people named Maya). Partial-tier; never auto-confirms.
      partial.add(r.wedding_id)
      continue
    }
  }

  if (exact.size > 0) {
    return { wedding_ids: Array.from(exact), tier: 'exact' }
  }
  if (partial.size > 0) {
    return { wedding_ids: Array.from(partial), tier: 'partial' }
  }
  return { wedding_ids: [], tier: 'none' }
}

// ---------------------------------------------------------------------------
// attribution_event writer
// ---------------------------------------------------------------------------

interface WriteAttributionEventInput {
  supabase: SupabaseClient
  venueId: string
  newWeddingId: string
  mention: ReferrerMention
  referrerWeddingId: string | null
  decidedBy: 'auto' | 'ai' | 'coordinator'
  tier:
    | 'tier_1_exact'
    | 'tier_1_name_window'
    | 'tier_1_full_name'
    | 'tier_2_ai'
    | 'tier_2_coordinator'
    | 'tier_3_manual'
  candidateNote: string | null
}

/**
 * Insert an attribution_events row for this referrer mention.
 *
 * The row carries:
 *   - venue_id, wedding_id (new couple)
 *   - referrer_wedding_id (the past couple, when matched)
 *   - referrer_name_text + referrer_relationship_text + referrer_evidence_quote
 *   - referrer_confidence_0_100 (from the LLM mention)
 *   - confidence (the tier-confidence; 95 for exact match, 60 for
 *     ambiguous/partial)
 *   - bucket: 'attribution' (referrals are always pre-inquiry signals)
 *   - source_platform: 'word_of_mouth_referral'
 *   - candidate_identity_id: null (Wave 14 referrals bypass the
 *     platform-signal cluster path)
 */
async function writeAttributionEvent(
  input: WriteAttributionEventInput,
): Promise<string> {
  const {
    supabase,
    venueId,
    newWeddingId,
    mention,
    referrerWeddingId,
    decidedBy,
    tier,
    candidateNote,
  } = input

  const tierConfidence =
    tier === 'tier_1_exact' || tier === 'tier_1_full_name'
      ? 95
      : tier === 'tier_2_coordinator'
        ? 80
        : tier === 'tier_2_ai'
          ? 70
          : 50

  const reasoningParts: string[] = []
  reasoningParts.push(`Wave 14 referral mention extracted by LLM (confidence ${mention.confidence_0_100}%)`)
  reasoningParts.push(`referrer_name="${mention.referrer_name}"`)
  reasoningParts.push(`relationship=${mention.relationship_to_couple}`)
  if (candidateNote) reasoningParts.push(candidateNote)

  const insertRow = {
    venue_id: venueId,
    wedding_id: newWeddingId,
    candidate_identity_id: null,
    referrer_wedding_id: referrerWeddingId,
    referrer_confidence_0_100: mention.confidence_0_100,
    referrer_evidence_quote: mention.evidence_quote,
    referrer_name_text: mention.referrer_name,
    referrer_relationship_text: mention.relationship_to_couple,
    referral_resolved_at: referrerWeddingId ? new Date().toISOString() : null,
    source_platform: 'word_of_mouth_referral',
    confidence: tierConfidence,
    tier,
    decided_by: decidedBy,
    reasoning: reasoningParts.join(' | '),
    is_first_touch: false, // referrer is a touch BEFORE the new couple's inquiry;
                            // but is_first_touch semantics in attribution_events
                            // are scoped to "earliest signal credited to THIS
                            // wedding". The referral is a forensic linkage, not
                            // an attributable signal channel. Leave false; the
                            // Wave 6/intel layer can re-compute first_touch
                            // semantics if it wants to credit referrals.
    bucket: 'attribution' as const,
    // KKK class-of-signal (mig 192 / 200). Word-of-mouth referral is
    // an acquisition channel ('source'), not a touchpoint. This is
    // what makes attribution_events with referrer_wedding_id flow
    // through last_touch/linear credit if/when the source-funnel
    // computer is extended to include 'word_of_mouth_referral'.
    signal_class: 'source' as const,
  }

  const { data, error } = await supabase
    .from('attribution_events')
    .insert(insertRow)
    .select('id')
    .single()
  if (error || !data) {
    throw new Error(
      `writeAttributionEvent failed: ${error?.message ?? 'no row returned'}`,
    )
  }
  return (data as { id: string }).id
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Resolve a single referrer mention against existing weddings in the
 * venue. Writes an attribution_event row (always, even for unmatched
 * referrers — the deferred-correlation case).
 *
 * Returns:
 *   - { kind: 'matched', ... } when exactly one wedding matched and
 *     the LLM confidence is ≥70 (the auto-link threshold).
 *   - { kind: 'ambiguous', ... } when multiple weddings matched OR
 *     when one matched but at partial-tier (last-name only) — defers
 *     to operator review.
 *   - { kind: 'deferred', ... } when no wedding matched — records the
 *     name for future correlation.
 *   - { kind: 'skipped', ... } when the mention is unusable (no name,
 *     or self-referral).
 *
 * NEVER throws on insert failure — wraps + returns skipped instead.
 */
export async function resolveReferrer(
  input: ResolveReferrerInput,
): Promise<ResolveReferrerResult> {
  const { newWeddingId, venueId, mention } = input
  const supabase = input.supabase ?? createServiceClient()

  if (!mention.referrer_name || mention.referrer_name.trim().length === 0) {
    return { kind: 'skipped', reason: 'empty_name' }
  }

  // Self-referral guard: if the named referrer matches a person on the
  // current wedding, skip (a couple can't refer themselves).
  try {
    const { data: ownPeople } = await supabase
      .from('people')
      .select('first_name, last_name')
      .eq('wedding_id', newWeddingId)
      .is('merged_into_id', null)
    const norm = normalizeName(mention.referrer_name)
    for (const p of (ownPeople ?? []) as Array<{
      first_name: string | null
      last_name: string | null
    }>) {
      const candidates: string[] = []
      if (p.first_name && p.last_name) {
        candidates.push(normalizeName(`${p.first_name} ${p.last_name}`))
      }
      if (p.first_name) candidates.push(normalizeName(p.first_name))
      if (p.last_name) candidates.push(normalizeName(p.last_name))
      if (candidates.includes(norm)) {
        return { kind: 'skipped', reason: 'self_referral' }
      }
    }
  } catch (err) {
    console.warn(
      '[referral-resolve] self-referral check threw; continuing',
      err instanceof Error ? err.message : err,
    )
  }

  // Look for candidate referrer weddings.
  const { wedding_ids, tier: matchTier } = await findCandidateReferrerWeddings(
    supabase,
    venueId,
    mention.referrer_name,
    newWeddingId,
  )

  // No matches → deferred correlation.
  if (wedding_ids.length === 0) {
    try {
      const eventId = await writeAttributionEvent({
        supabase,
        venueId,
        newWeddingId,
        mention,
        referrerWeddingId: null,
        decidedBy: 'ai',
        tier: 'tier_2_ai',
        candidateNote: 'no_candidate_wedding_in_venue',
      })
      return { kind: 'deferred', attributionEventId: eventId }
    } catch (err) {
      return {
        kind: 'skipped',
        reason: `write_failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Single exact match with high LLM confidence → auto-link.
  if (
    wedding_ids.length === 1
    && matchTier === 'exact'
    && mention.confidence_0_100 >= 70
  ) {
    try {
      const eventId = await writeAttributionEvent({
        supabase,
        venueId,
        newWeddingId,
        mention,
        referrerWeddingId: wedding_ids[0],
        decidedBy: 'auto',
        tier: 'tier_1_exact',
        candidateNote: 'single_exact_name_match',
      })
      return {
        kind: 'matched',
        attributionEventId: eventId,
        referrerWeddingId: wedding_ids[0],
      }
    } catch (err) {
      return {
        kind: 'skipped',
        reason: `write_failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  // Multiple matches OR partial-tier OR low LLM confidence → ambiguous,
  // defer to operator. Per the spec: "Do NOT auto-execute referral
  // linkage on low-confidence matches — defer to operator review".
  try {
    const eventId = await writeAttributionEvent({
      supabase,
      venueId,
      newWeddingId,
      mention,
      referrerWeddingId: null,
      decidedBy: 'ai',
      tier: 'tier_2_ai',
      candidateNote: `ambiguous: ${wedding_ids.length} candidate(s); match_tier=${matchTier}`,
    })
    return {
      kind: 'ambiguous',
      attributionEventId: eventId,
      candidateWeddingIds: wedding_ids,
    }
  } catch (err) {
    return {
      kind: 'skipped',
      reason: `write_failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
