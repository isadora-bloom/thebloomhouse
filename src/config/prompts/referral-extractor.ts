/**
 * Bloom House — Wave 14 referral-extraction prompt.
 *
 * Anchor docs:
 *   - bloom-constitution.md (every populated claim carries a verbatim
 *     evidence_quote; no fabrication; referrer mention is a forensic
 *     claim about who recommended this couple)
 *   - bloom-wave4-identity-reconstruction.md (Wave 4 is the sealed
 *     forensic substrate; Wave 14 is a SIBLING extractor that reads
 *     the stored profile + recent interactions and extracts referrer
 *     mentions as a separate pass)
 *   - bloom-phase-b-decisions.md (attribution_events is the audit row
 *     per attribution decision; Wave 14 extends with referrer_wedding_id
 *     linkage instead of candidate_identity_id)
 *   - feedback_deep_fix_vs_bandaid.md (the LLM judges referrer mentions
 *     from full body context — regex on "told me about" is the
 *     band-aid the LLM replaces)
 *
 * Different LLM job from Wave 4
 * -----------------------------
 * Wave 4 reconstructs WHO the couple is. Wave 14 reads what Wave 4
 * already stored + recent interactions and extracts WHO sent them. The
 * referrer name + relationship + evidence_quote + confidence go into
 * attribution_events. Cheap (Haiku, low temperature, ~$0.003/wedding).
 *
 * Sibling-extractor doctrine
 * --------------------------
 * Wave 14 NEVER modifies reconstruct.ts. It reads couple_identity_profile
 * after the Wave 4 reconstruction completes (post-reconstruction enqueue)
 * and produces a separate structured output. If the couple has no
 * referrer mention, the extractor returns an empty array — that's the
 * common case for any inquiry channel that isn't word-of-mouth.
 */

import type { CoupleIdentityProfile } from '@/config/prompts/identity-reconstruction'

// Bumping this constant forces every consumer to either accept the new
// prompt's output or version-pin. Threaded into api_costs.prompt_version
// so a regression audit can correlate cost + quality + revision.
export const REFERRAL_EXTRACTOR_PROMPT_VERSION = 'referral-extractor.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — mirror the wire JSON the prompt asks for.
// ---------------------------------------------------------------------------

export type ReferrerRelationship =
  | 'friend'
  | 'family_member'
  | 'past_couple'
  | 'vendor'
  | 'unknown'

export interface ReferrerMention {
  referrer_name: string
  relationship_to_couple: ReferrerRelationship
  evidence_quote: string
  confidence_0_100: number
}

export interface ReferralExtractionOutput {
  referrer_mentions: ReferrerMention[]
  refusals: Array<{ field: string; reason: string }>
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface ReferralInteractionEvidence {
  index: number
  direction: 'inbound' | 'outbound'
  from_email: string | null
  from_name: string | null
  subject: string | null
  body_excerpt: string | null
  timestamp: string | null
}

export interface ReferralEvidence {
  weddingId: string
  venueLabel: string | null
  profile: CoupleIdentityProfile
  /** Most-recent-first window of inbound + outbound interactions. */
  recentInteractions: ReferralInteractionEvidence[]
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSystemPrompt(): string {
  return `You are Bloom's referral-attribution extractor.

Bloom is a forensic identity-reconstruction system for wedding venues.
Wave 4 produced the forensic profile (WHO this couple is). Your Wave 14
job is narrow: read the structured profile + recent interactions and
extract every mention of being REFERRED to this venue by another
specific person.

## WHAT COUNTS AS A REFERRAL MENTION

Examples of mentions you SHOULD extract:
  - "Maya recommended you" → referrer_name: "Maya"
  - "We heard about you from Jenny" → referrer_name: "Jenny"
  - "My cousin Sarah got married here last summer" → referrer_name: "Sarah", relationship: family_member
  - "Our friend Alex told us about Rixey" → referrer_name: "Alex", relationship: friend
  - "Our planner Lisa Marshall suggested we tour" → referrer_name: "Lisa Marshall", relationship: vendor
  - "Erin's wedding was here in May" → referrer_name: "Erin", relationship: past_couple

Examples of mentions you SHOULD NOT extract (these are NOT referrals):
  - Generic vendor names appearing in calculator/quote forms with no
    referral context ("Florist: ABC Flowers")
  - Generic platform mentions ("We saw you on Knot")
  - Self-references ("I'm Sarah")
  - The couple's own family members mentioned as wedding guests
    ("My mom Karen will attend")
  - Vendors named as preferences without a referral context

## CORE RULES

1. **Verbatim evidence_quote.** Every mention MUST carry a verbatim
   substring from the input as evidence_quote. Short (≤200 chars). No
   paraphrasing. If you cannot find a verbatim quote, do NOT include
   the mention.

2. **Don't fabricate.** When the body is silent on referrals, return
   { "referrer_mentions": [] }. Most couples have NO referral mentions
   — that's the common case.

3. **Relationship classification:**
   - friend: explicit "friend", "buddy", "we know X"
   - family_member: explicit "cousin", "sister", "aunt", "uncle",
     "mother", "father", "in-law"
   - past_couple: explicit "got married here", "her wedding was at
     [venue]", "they had their reception"
   - vendor: explicit "planner", "florist", "photographer",
     "coordinator"
   - unknown: referrer mentioned but relationship not specified

4. **Confidence (0-100):**
   - 90-100: explicit "X recommended us" / "X referred us" with a
     full name
   - 70-89: "X told us about you" or "we heard about you from X" with
     a partial name (first name only)
   - 50-69: implied referral (e.g. "our friend's wedding was here")
     with a name but without an explicit "recommend" verb
   - 30-49: name appears in a wedding-positive context but
     referral-direction unclear
   - Anything below 30 → do NOT include the mention; add a refusal
     entry instead.

5. **Multiple mentions allowed.** A single body can name multiple
   referrers. Extract each separately.

6. **Same person, multiple quotes → one mention.** If "Maya recommended
   us" appears in three emails, return ONE mention with the strongest
   evidence_quote (the most explicit one).

7. **Refusals are the audit trail.** When you spotted a possible
   referral but the evidence was too weak to include (confidence <30,
   no verbatim quote available, ambiguous relationship), add a refusal
   entry: { field: "referrer", reason: "..." }.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences,
no comments:

{
  "referrer_mentions": [
    {
      "referrer_name": string,
      "relationship_to_couple": "friend" | "family_member" | "past_couple" | "vendor" | "unknown",
      "evidence_quote": string,
      "confidence_0_100": integer 0-100
    }
  ],
  "refusals": [
    { "field": string, "reason": string }
  ]
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt — serialise the evidence with section headers.
// ---------------------------------------------------------------------------

const MAX_INTERACTION_BODY_CHARS = 1500

function truncate(text: string | null, max: number): string | null {
  if (!text) return null
  if (text.length <= max) return text
  return text.slice(0, max) + '\n[...truncated]'
}

export function buildUserPrompt(evidence: ReferralEvidence): string {
  const lines: string[] = []
  const { weddingId, venueLabel, profile, recentInteractions } = evidence

  lines.push('# COUPLE TO EXTRACT REFERRAL MENTIONS FOR')
  lines.push('')
  lines.push(`Wedding ID: ${weddingId}`)
  if (venueLabel) lines.push(`Venue: ${venueLabel}`)
  lines.push('')

  // ---- Forensic profile (already-extracted signals that may hint at referral context) ----
  lines.push('## Forensic identity profile (from couple_identity_profile)')
  lines.push('')
  if (profile.family_dynamics.length > 0) {
    lines.push('### Family dynamics (may name referrers via family context)')
    for (const f of profile.family_dynamics) {
      lines.push(`- ${f.relationship}: ${f.signal} ("${f.evidence_quote}")`)
    }
    lines.push('')
  }
  if (profile.cultural_signals.length > 0) {
    lines.push('### Cultural signals')
    for (const c of profile.cultural_signals) {
      lines.push(`- ${c.signal} ("${c.evidence_quote}")`)
    }
    lines.push('')
  }
  if (profile.vendor_preferences.length > 0) {
    lines.push('### Vendor preferences (vendor name ≠ referrer; only count if explicit referral)')
    for (const v of profile.vendor_preferences) {
      lines.push(`- ${v.vendor_type}: ${v.preference} ("${v.evidence_quote}")`)
    }
    lines.push('')
  }

  // ---- Recent interactions (the body text the referral mention lives in) ----
  lines.push('## Recent interactions (most-recent-first)')
  lines.push('')
  if (recentInteractions.length === 0) {
    lines.push('(no interactions on record)')
    lines.push('')
  } else {
    for (const it of recentInteractions) {
      lines.push(`### Interaction ${it.index} (${it.direction})`)
      if (it.timestamp) lines.push(`- timestamp: ${it.timestamp}`)
      if (it.from_email) lines.push(`- from_email: ${it.from_email}`)
      if (it.from_name) lines.push(`- from_name: ${it.from_name}`)
      if (it.subject) lines.push(`- subject: ${it.subject}`)
      const body = truncate(it.body_excerpt, MAX_INTERACTION_BODY_CHARS)
      if (body) {
        lines.push('- body:')
        lines.push(body)
      }
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('Return ONLY the JSON described in the system prompt.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator — narrow + defensive. Returns either {ok:true} or {ok:false}.
// ---------------------------------------------------------------------------

const RELATIONSHIP_VALUES: ReadonlyArray<ReferrerRelationship> = [
  'friend',
  'family_member',
  'past_couple',
  'vendor',
  'unknown',
]

export type ValidationResult =
  | { ok: true; output: ReferralExtractionOutput }
  | { ok: false; error: string }

export function validateReferralExtractionOutput(value: unknown): ValidationResult {
  if (!value || typeof value !== 'object') {
    return { ok: false, error: 'not an object' }
  }
  const obj = value as Record<string, unknown>
  const mentionsRaw = obj.referrer_mentions
  if (!Array.isArray(mentionsRaw)) {
    return { ok: false, error: 'referrer_mentions must be an array' }
  }
  const refusalsRaw = obj.refusals
  if (!Array.isArray(refusalsRaw)) {
    return { ok: false, error: 'refusals must be an array' }
  }

  const mentions: ReferrerMention[] = []
  for (let i = 0; i < mentionsRaw.length; i++) {
    const m = mentionsRaw[i]
    if (!m || typeof m !== 'object') {
      return { ok: false, error: `referrer_mentions[${i}] not an object` }
    }
    const rec = m as Record<string, unknown>
    const name = rec.referrer_name
    const rel = rec.relationship_to_couple
    const quote = rec.evidence_quote
    const conf = rec.confidence_0_100
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { ok: false, error: `referrer_mentions[${i}].referrer_name missing` }
    }
    if (typeof rel !== 'string' || !RELATIONSHIP_VALUES.includes(rel as ReferrerRelationship)) {
      return { ok: false, error: `referrer_mentions[${i}].relationship_to_couple invalid` }
    }
    if (typeof quote !== 'string' || quote.trim().length === 0) {
      return { ok: false, error: `referrer_mentions[${i}].evidence_quote missing` }
    }
    if (typeof conf !== 'number' || !Number.isFinite(conf) || conf < 0 || conf > 100) {
      return { ok: false, error: `referrer_mentions[${i}].confidence_0_100 invalid` }
    }
    mentions.push({
      referrer_name: name.trim(),
      relationship_to_couple: rel as ReferrerRelationship,
      evidence_quote: quote.trim(),
      confidence_0_100: Math.round(conf),
    })
  }

  const refusals: Array<{ field: string; reason: string }> = []
  for (let i = 0; i < refusalsRaw.length; i++) {
    const r = refusalsRaw[i]
    if (!r || typeof r !== 'object') {
      return { ok: false, error: `refusals[${i}] not an object` }
    }
    const rec = r as Record<string, unknown>
    if (typeof rec.field !== 'string' || typeof rec.reason !== 'string') {
      return { ok: false, error: `refusals[${i}] missing field/reason` }
    }
    refusals.push({ field: rec.field, reason: rec.reason })
  }

  return { ok: true, output: { referrer_mentions: mentions, refusals } }
}
