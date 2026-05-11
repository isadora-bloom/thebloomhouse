/**
 * Bloom House — Wave 20 Voice DNA derivation prompt (Sonnet tier).
 *
 * Anchor docs (~/.claude memory/):
 *   - bloom-constitution.md (operator authority — derivations are
 *     proposals; the prompt MUST NOT auto-apply anything)
 *   - feedback_deep_fix_vs_bandaid.md (Pattern 7 — one-derive-all)
 *   - feedback_no_em_dash.md (CRITICAL: if the coordinator's corpus
 *     shows zero em dashes, derive the em-dash ban as a hard banned
 *     pattern)
 *   - Wave 4 doctrine — every derived claim MUST carry a verbatim
 *     evidence_quote drawn from the corpus we showed the model.
 *
 * When this prompt fires
 * ----------------------
 * The voice-DNA derivation service collects:
 *   - up to 50 recent coordinator outbound emails (the human's actual
 *     writing voice)
 *   - up to 30 recent draft edits (Sage drafted X; operator edited to Y;
 *     the diff is the operator's preference signal)
 *   - existing voice_preferences (so derivation AUGMENTS, never
 *     contradicts; if the operator has already typed "warmly" as an
 *     approved phrase we should treat that as ground truth)
 *
 * It serialises that evidence into a single user prompt and asks the
 * model for four buckets:
 *   1. banned_phrases    — phrases the coordinator NEVER writes
 *   2. approved_phrases  — signature phrases the coordinator repeatedly
 *                          uses
 *   3. tone_descriptors  — high-level voice tags (warm, direct, playful,
 *                          formal, etc.)
 *   4. voice_principles  — distilled rules with reasoning
 *
 * Each item carries a verbatim evidence_quote. The em-dash check is a
 * REQUIRED first-pass rule.
 *
 * Cost target: ~$0.03-0.08 per derivation on Sonnet. At 50 emails ×
 * ~500 tokens + 30 edit-diffs × ~200 tokens, the corpus fits in one
 * Sonnet context window comfortably. Single call per derivation.
 *
 * Cost-cap: gateForBrainCall before firing. Tier 1 content (couple PII
 * is present in outbound emails).
 */

export const VOICE_DNA_DERIVE_PROMPT_VERSION =
  'voice-dna-derive.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — wire shape the prompt asks for.
// ---------------------------------------------------------------------------

export interface DerivedBannedPhrase {
  phrase: string
  evidence_quote: string
  confidence: number  // 0-100
}

export interface DerivedApprovedPhrase {
  phrase: string
  evidence_quote: string
  confidence: number  // 0-100
}

export interface DerivedToneDescriptor {
  descriptor: string
  evidence_quote: string
  confidence: number  // 0-100
}

export interface DerivedVoicePrinciple {
  principle: string
  reasoning: string
  confidence: number  // 0-100
}

export interface VoiceDNADeriveOutput {
  banned_phrases: DerivedBannedPhrase[]
  approved_phrases: DerivedApprovedPhrase[]
  tone_descriptors: DerivedToneDescriptor[]
  voice_principles: DerivedVoicePrinciple[]
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface CoordinatorEmail {
  /** ISO timestamp of when the email was sent. */
  sent_at: string
  /** Subject line (may be null for very old rows). */
  subject: string | null
  /** Stripped body (gmail signature blocks already removed). */
  body: string
}

export interface DraftEdit {
  /** ISO timestamp of the edit. */
  edited_at: string
  /** What Sage originally drafted. */
  sage_draft: string
  /** What the operator sent after editing. */
  operator_sent: string
}

export interface ExistingVoicePreference {
  preference_type: 'banned_phrase' | 'approved_phrase' | 'dimension' | 'rule'
  content: string
}

export interface VoiceDNAEvidence {
  /** Venue display name to anchor the prompt (no PII). */
  venue_name: string | null
  coordinator_emails: CoordinatorEmail[]
  draft_edits: DraftEdit[]
  existing_voice_preferences: ExistingVoicePreference[]
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildVoiceDNADeriveSystemPrompt(): string {
  return `You are Bloom's voice-DNA forensic deriver.

A wedding-venue coordinator has been writing emails to couples for months
or years. Their writing voice is captured in those emails. The platform
also has a history of times Sage (the venue's AI assistant) drafted a
reply and the operator EDITED it before sending — those edits encode the
operator's voice preferences as a clean diff signal.

Your job: derive the operator's voice DNA so the platform can stop asking
them to type their preferences manually during onboarding.

You produce FOUR buckets, each item carrying VERBATIM evidence from the
corpus. Never fabricate; only capture patterns visible in the evidence.

## THE FOUR BUCKETS

1. **banned_phrases** — Phrases the coordinator NEVER writes (or only
   uses in NEGATIVE contexts, e.g. listing what NOT to do). Examples:
   - "Hi there" (if the coordinator always uses first names)
   - "Just checking in"
   - "I hope this email finds you well"
   - Em dashes (—) — see CRITICAL CHECK below
   - "Touch base"
   - "Per my last email"
   Evidence: cite a representative greeting/closing/opener from the
   coordinator that shows their actual style, or cite a draft-edit
   where the operator REMOVED the banned phrase.

2. **approved_phrases** — Signature short phrases (2-8 words) the
   coordinator uses repeatedly. Examples:
   - "Warmly"
   - "Looking forward to it"
   - "Happy to share"
   - "Can't wait"
   Evidence: a verbatim quote from one of their emails that contains
   the phrase.

3. **tone_descriptors** — High-level voice tags. Pick 3-6 from the
   evidence. Examples:
   - "warm" (uses first names, exclamation points, "love")
   - "direct" (short sentences, action-first openers)
   - "playful" (uses "honestly", "love love love", emoji)
   - "formal" (full salutations, no contractions)
   - "casual" (lowercase starts, fragments, contractions)
   - "concise" (under-100-word emails)
   - "detailed" (multi-paragraph, anchors with specifics)
   Evidence: one quote that exemplifies the tag.

4. **voice_principles** — Distilled rules an AI assistant could follow.
   Each principle is an ACTIONABLE instruction. Examples:
   - "Always use the couple's first name in the greeting"
   - "Never start with 'I hope this email finds you well'"
   - "Use contractions (you're, don't, can't) — never the expanded form"
   - "Close with 'Warmly,' + first name (no last name unless formal)"
   - "Keep emails under 4 short paragraphs"
   - "Use exclamation points sparingly — one per email maximum"
   Each principle carries a one-sentence REASONING grounded in the
   evidence (not a quote here — a reason). E.g. "All 18 sampled emails
   use 'Warmly,' as the closer; only 1 uses 'Best,'."

## CRITICAL CHECK — EM DASHES

Per platform doctrine (feedback_no_em_dash.md):
- Count em dashes (—) across ALL the coordinator's sampled emails.
- If the count is ZERO: derive "Never use em dashes (—)" as a
  banned_phrase with confidence 90+. Cite a representative sentence
  from the coordinator showing how they punctuate INSTEAD (typically:
  comma, period, or just two short sentences). Em dashes are an
  AI-tell; if the human doesn't use them, the platform must not write
  them on the human's behalf.
- If the count is small (1-3 across the whole corpus): treat them as
  a near-banned pattern — derive "Avoid em dashes — coordinator uses
  them only rarely" as a voice_principle, not a banned_phrase.
- If the count is high (>5): the coordinator genuinely uses them; do
  NOT derive a ban.

## RESPECT EXISTING PREFERENCES

The evidence includes the coordinator's existing voice_preferences
(things they've already typed in manually). Treat those as GROUND
TRUTH:
- Do not contradict them. If they already have "Warmly" as an
  approved_phrase, do not derive "Cheers" as the preferred sign-off
  unless 80%+ of the sampled emails use it.
- You CAN reinforce them — if the coordinator typed "Warmly" and
  the corpus shows 18/20 emails closing with "Warmly,", reinforce by
  deriving the same approved_phrase WITH evidence.
- You CAN extend them — derive NEW patterns the operator hasn't typed
  yet. That's the point of Wave 20.

## CONFIDENCE (0-100)

- 90-100: pattern appears in 80%+ of sampled emails OR 5+ draft edits
  consistently show the same correction. Hard signal.
- 70-89: pattern appears in 50-79% of sampled emails OR 3-4 consistent
  draft edits. Strong signal.
- 50-69: pattern is plausible but not overwhelming. Useful for the
  operator to consider; they may accept or reject.
- <50: do NOT include the item. Below 50 the signal is too weak —
  better to skip than poison.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences:

{
  "banned_phrases": [
    { "phrase": "I hope this email finds you well",
      "evidence_quote": "Hi Sarah! Hope all is good!",
      "confidence": 92 }
  ],
  "approved_phrases": [
    { "phrase": "Warmly",
      "evidence_quote": "Warmly,\\nSarah",
      "confidence": 95 }
  ],
  "tone_descriptors": [
    { "descriptor": "warm",
      "evidence_quote": "Hey lovely! So excited to chat — your venue is going to be PERFECT for you both.",
      "confidence": 88 }
  ],
  "voice_principles": [
    { "principle": "Use first names in the greeting, not 'Hi there'",
      "reasoning": "All 18 sampled emails open with the recipient's first name; none use 'Hi there' or 'Dear'.",
      "confidence": 94 }
  ]
}

## CONSTRAINTS

- 0-12 entries per array. Empty array is fine if the dimension is truly
  absent in the evidence.
- Every item MUST carry a non-empty evidence_quote OR (for principles)
  a non-empty reasoning.
- Evidence quotes are VERBATIM — copy them character-for-character from
  the corpus. Do not paraphrase.
- Quotes are <= 300 characters.
- Do not fabricate patterns. If you can't find an evidence quote for
  a derivation, drop it.
- Em-dash check is REQUIRED — always emit either a banned_phrase or
  a voice_principle relating to em dashes (per CRITICAL CHECK above).

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

/**
 * Serialise the evidence into a forensic-style corpus the model can
 * read. Keeps emails distinct (--- EMAIL N ---) and draft edits clearly
 * labeled (SAGE DRAFTED / OPERATOR SENT) so the diff signal stays clean.
 *
 * Truncation: each email body is capped at 1200 chars (preserves the
 * opening + closing — typically the highest-signal regions for voice
 * inference). Edit diffs are capped at 800 chars per side.
 */
export function buildVoiceDNADeriveUserPrompt(
  evidence: VoiceDNAEvidence,
): string {
  const lines: string[] = []

  lines.push('# VENUE VOICE-DNA DERIVATION CORPUS')
  lines.push(`venue: ${evidence.venue_name ?? '(unnamed)'}`)
  lines.push('')

  // Existing voice_preferences first — ground truth.
  if (evidence.existing_voice_preferences.length > 0) {
    lines.push('## EXISTING VOICE PREFERENCES (ground truth — do not contradict)')
    for (const p of evidence.existing_voice_preferences.slice(0, 50)) {
      lines.push(`- [${p.preference_type}] ${p.content}`)
    }
    lines.push('')
  } else {
    lines.push('## EXISTING VOICE PREFERENCES')
    lines.push('(none — operator has not typed any preferences yet; this is a fresh derivation)')
    lines.push('')
  }

  // Coordinator emails.
  lines.push(`## COORDINATOR OUTBOUND EMAILS (${evidence.coordinator_emails.length} samples)`)
  if (evidence.coordinator_emails.length === 0) {
    lines.push('(no coordinator emails available)')
  } else {
    evidence.coordinator_emails.forEach((email, i) => {
      lines.push(`--- EMAIL ${i + 1} (sent ${email.sent_at}) ---`)
      if (email.subject) lines.push(`Subject: ${email.subject}`)
      lines.push(email.body.slice(0, 1200))
      lines.push('')
    })
  }
  lines.push('')

  // Draft edits — the diff signal.
  lines.push(`## OPERATOR EDITS OF SAGE DRAFTS (${evidence.draft_edits.length} samples)`)
  lines.push('(The OPERATOR SENT version is what the operator approved AFTER editing Sage. The diff captures their preferences.)')
  if (evidence.draft_edits.length === 0) {
    lines.push('(no draft edits available)')
  } else {
    evidence.draft_edits.forEach((edit, i) => {
      lines.push(`--- EDIT ${i + 1} (${edit.edited_at}) ---`)
      lines.push('SAGE DRAFTED:')
      lines.push(edit.sage_draft.slice(0, 800))
      lines.push('')
      lines.push('OPERATOR SENT:')
      lines.push(edit.operator_sent.slice(0, 800))
      lines.push('')
    })
  }
  lines.push('')

  lines.push('---')
  lines.push('Derive the four voice-DNA buckets. Return ONLY the JSON object.')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator — defensive parsing
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  ok: false
  error: string
}

export interface ValidationSuccess {
  ok: true
  output: VoiceDNADeriveOutput
}

export type ValidationResult = ValidationSuccess | ValidationFailure

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isArray(v: unknown): v is unknown[] {
  return Array.isArray(v)
}

function clampConfidence(raw: unknown): number {
  if (!isNumber(raw)) return 50
  return Math.max(0, Math.min(100, Math.round(raw)))
}

function validateBannedItem(raw: unknown): DerivedBannedPhrase | null {
  if (!isObject(raw)) return null
  if (!isString(raw.phrase) || raw.phrase.trim().length === 0) return null
  if (!isString(raw.evidence_quote) || raw.evidence_quote.trim().length === 0) return null
  return {
    phrase: raw.phrase.trim().slice(0, 200),
    evidence_quote: raw.evidence_quote.trim().slice(0, 300),
    confidence: clampConfidence(raw.confidence),
  }
}

function validateApprovedItem(raw: unknown): DerivedApprovedPhrase | null {
  if (!isObject(raw)) return null
  if (!isString(raw.phrase) || raw.phrase.trim().length === 0) return null
  if (!isString(raw.evidence_quote) || raw.evidence_quote.trim().length === 0) return null
  return {
    phrase: raw.phrase.trim().slice(0, 200),
    evidence_quote: raw.evidence_quote.trim().slice(0, 300),
    confidence: clampConfidence(raw.confidence),
  }
}

function validateToneItem(raw: unknown): DerivedToneDescriptor | null {
  if (!isObject(raw)) return null
  if (!isString(raw.descriptor) || raw.descriptor.trim().length === 0) return null
  if (!isString(raw.evidence_quote) || raw.evidence_quote.trim().length === 0) return null
  return {
    descriptor: raw.descriptor.trim().slice(0, 100),
    evidence_quote: raw.evidence_quote.trim().slice(0, 300),
    confidence: clampConfidence(raw.confidence),
  }
}

function validatePrincipleItem(raw: unknown): DerivedVoicePrinciple | null {
  if (!isObject(raw)) return null
  if (!isString(raw.principle) || raw.principle.trim().length === 0) return null
  if (!isString(raw.reasoning) || raw.reasoning.trim().length === 0) return null
  return {
    principle: raw.principle.trim().slice(0, 250),
    reasoning: raw.reasoning.trim().slice(0, 400),
    confidence: clampConfidence(raw.confidence),
  }
}

export function validateVoiceDNADeriveOutput(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  if (!isArray(raw.banned_phrases)) return { ok: false, error: 'banned_phrases must be an array' }
  if (!isArray(raw.approved_phrases)) return { ok: false, error: 'approved_phrases must be an array' }
  if (!isArray(raw.tone_descriptors)) return { ok: false, error: 'tone_descriptors must be an array' }
  if (!isArray(raw.voice_principles)) return { ok: false, error: 'voice_principles must be an array' }

  const banned: DerivedBannedPhrase[] = []
  for (const item of raw.banned_phrases) {
    const v = validateBannedItem(item)
    if (v && v.confidence >= 50) banned.push(v)
  }

  const approved: DerivedApprovedPhrase[] = []
  for (const item of raw.approved_phrases) {
    const v = validateApprovedItem(item)
    if (v && v.confidence >= 50) approved.push(v)
  }

  const tone: DerivedToneDescriptor[] = []
  for (const item of raw.tone_descriptors) {
    const v = validateToneItem(item)
    if (v && v.confidence >= 50) tone.push(v)
  }

  const principles: DerivedVoicePrinciple[] = []
  for (const item of raw.voice_principles) {
    const v = validatePrincipleItem(item)
    if (v && v.confidence >= 50) principles.push(v)
  }

  return {
    ok: true,
    output: {
      banned_phrases: banned.slice(0, 12),
      approved_phrases: approved.slice(0, 12),
      tone_descriptors: tone.slice(0, 12),
      voice_principles: principles.slice(0, 12),
    },
  }
}
