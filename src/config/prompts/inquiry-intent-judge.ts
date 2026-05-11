/**
 * Bloom House — Wave 16 inquiry-intent judge prompt (Haiku tier).
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic — the judge sees the evidence
 *     and commits to one of targeted/broadcast/validation/refusal)
 *   - bloom-may9-llm-vs-template.md (Haiku for classification with
 *     bounded schema; tier-correct mapping)
 *   - feedback_self_reported_sources_not_truth.md (disagreement is the
 *     gold — when stated channel diverges from actual intent, the
 *     forensic evidence wins)
 *
 * When this prompt fires
 * ----------------------
 * The forensic intent classifier defers to this judge ONLY when the
 * templateScore sits in the ambiguous 40-59 band — strong enough to
 * suspect broadcast but weak enough that personalisation might
 * actually be present. At <40 the rule fires 'targeted' directly; at
 * >=60 + no post-inquiry engagement it fires 'broadcast' directly.
 *
 * Output: ONLY the JSON object.
 *
 * Cost target: ~$0.003 per call on Haiku. At Rixey scale (~100 Knot
 * inquiries/yr × ~15-25% deferred-to-judge rate) that's pennies. At
 * Wedgewood scale (80 venues × similar volume) still under $5/yr in
 * judge calls.
 */

export const INQUIRY_INTENT_JUDGE_PROMPT_VERSION =
  'inquiry-intent-judge.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — wire shape the prompt asks for.
// ---------------------------------------------------------------------------

export type InquiryIntentClass = 'targeted' | 'broadcast' | 'validation'

export interface InquiryIntentJudgeOutput {
  intent_class: InquiryIntentClass | null
  confidence_0_100: number
  reasoning: string
  refusal: string | null
}

// ---------------------------------------------------------------------------
// Evidence types — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface IntentJudgeEvidence {
  attribution_event_id: string
  source_platform: string
  /** ISO timestamp of the inquiry. */
  inquiry_decided_at: string
  /** Inquiry body, with platform chrome stripped. */
  inquiry_body_stripped: string
  /** Subject line, useful when the body is bare. */
  inquiry_subject: string | null
  /** Template detector output, threaded in as forensic ground. */
  template_score_0_100: number
  matched_patterns: string[]
  personalisation_deficit_0_30: number
  /** Post-inquiry engagement summary. */
  post_inquiry_interaction_count: number
  post_inquiry_tour_count: number
  post_inquiry_days_silent: number | null
  /** Venue context to help the judge weigh personalisation. */
  venue_name: string | null
  venue_state: string | null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildInquiryIntentSystemPrompt(): string {
  return `You are Bloom's inquiry-intent forensic judge.

Bloom is a forensic identity-reconstruction system for wedding venues. Wave
16 classifies the INTENT of a wedding-venue inquiry as targeted (couple
actively chose this venue), broadcast (Knot/WeddingWire's "Inquire to
similar venues" algorithm distributed the couple's interest to many
venues without the couple actively picking), or validation (couple found
the venue elsewhere; the inquiry is just intake).

Your job: judge ONE attribution event when the forensic rule is
ambiguous (templateScore 40-59 zone). The forensic check already
deferred to you — the pattern signal is mixed.

## INTENT CLASSES (pick one or refuse)

1. **targeted** — Couple actively chose this venue. Evidence:
   - Personalised inquiry body (mentions venue name, references
     specific features, asks about specific details)
   - OR the couple subsequently engaged after the inquiry (replies,
     tour bookings, post-inquiry interactions within 14 days)
   - OR the body shows distinct voice rather than templated phrasing

2. **broadcast** — Platform auto-distributed the inquiry to this venue
   without the couple actively choosing. Evidence:
   - Body matches Knot/WW broadcast template (generic phrases, no
     venue-specific reference, "looking for options")
   - AND the couple did NOT engage after the inquiry (zero replies,
     no tour booking, no post-inquiry interactions for 14+ days)
   - Strong indicator: matched_patterns count >= 2 AND post-inquiry
     interactions == 0 AND tour bookings == 0

3. **validation** — Couple found the venue elsewhere; this inquiry is
   just the intake form. Evidence:
   - Body references having "seen" or "found" the venue (Instagram,
     planner, friend, etc.) but uses the channel as the form
   - Couple followed up: reply, tour booking — they came in knowing
     the venue.
   - This is rarer than the other two for ambiguous cases (Wave 7B's
     role classifier handles most validation cases on a different
     dimension; you mainly see it here when the body is templated but
     post-inquiry engagement is high)

## CORE RULES

1. **Post-inquiry engagement is the strongest forensic signal.** A
   couple who replies, books a tour, or sends a second message
   ACTIVELY engaged after this inquiry — that's evidence they chose
   the venue. Heavy weight on this even when the inquiry body itself
   is templated.

2. **Template score is forensic ground but not destiny.** A 50 score
   means roughly half-broadcast, half-personalised signals. Tip the
   scale toward broadcast when post-inquiry engagement is zero; tip
   toward targeted when post-inquiry engagement is present.

3. **Matched patterns reflect template-detection hits.** More patterns
   matched = more broadcast-like. Two+ matched patterns + zero
   post-inquiry engagement is almost certainly broadcast.

4. **Refuse when truly ambiguous.** If templateScore is exactly 50,
   one matched pattern, post-inquiry engagement count is 1, and you
   cannot rank the evidence, return intent_class:null with a non-empty
   refusal. Better to defer than to commit incorrectly.

5. **Confidence (0-100):**
   - 80-100: clear path; one or more rules cleanly apply
   - 60-79: judgement call; one signal slightly outweighs the other
   - 40-59: borderline; consider refusing
   - <40: should usually be a refusal

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences:

{
  "intent_class": "targeted" | "broadcast" | "validation" | null,
  "confidence_0_100": integer 0-100,
  "reasoning": string (1-2 sentences),
  "refusal": string | null
}

When refusal is non-null, intent_class MUST be null. When intent_class
is non-null, refusal MUST be null.

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

export function buildInquiryIntentUserPrompt(
  evidence: IntentJudgeEvidence,
): string {
  const lines: string[] = []
  lines.push('# INQUIRY EVENT TO CLASSIFY')
  lines.push('')
  lines.push(`attribution_event_id: ${evidence.attribution_event_id}`)
  lines.push(`source_platform:      ${evidence.source_platform}`)
  lines.push(`inquiry_decided_at:   ${evidence.inquiry_decided_at}`)
  lines.push(`venue_name:           ${evidence.venue_name ?? '(none)'}`)
  lines.push(`venue_state:          ${evidence.venue_state ?? '(none)'}`)
  lines.push('')

  lines.push('## TEMPLATE DETECTOR OUTPUT')
  lines.push(`templateScore (0-100): ${evidence.template_score_0_100}`)
  lines.push(`personalisationDeficit (0-30): ${evidence.personalisation_deficit_0_30}`)
  if (evidence.matched_patterns.length === 0) {
    lines.push('matched_patterns: (none)')
  } else {
    lines.push(`matched_patterns (${evidence.matched_patterns.length}):`)
    for (const p of evidence.matched_patterns) {
      lines.push(`  - ${p}`)
    }
  }
  lines.push('')

  lines.push('## POST-INQUIRY ENGAGEMENT (within 14 days after inquiry)')
  lines.push(`interactions_count: ${evidence.post_inquiry_interaction_count}`)
  lines.push(`tour_bookings_count: ${evidence.post_inquiry_tour_count}`)
  if (evidence.post_inquiry_days_silent !== null) {
    lines.push(`days_silent_after_inquiry: ${evidence.post_inquiry_days_silent}`)
  } else {
    lines.push('days_silent_after_inquiry: (not yet determinable — inquiry too recent)')
  }
  lines.push('')

  lines.push('## INQUIRY BODY (platform chrome stripped)')
  if (evidence.inquiry_subject) {
    lines.push(`Subject: ${evidence.inquiry_subject}`)
    lines.push('')
  }
  if (!evidence.inquiry_body_stripped || evidence.inquiry_body_stripped.length === 0) {
    lines.push('(body empty after platform chrome stripped)')
  } else {
    lines.push(evidence.inquiry_body_stripped.slice(0, 2000))
  }
  lines.push('')

  lines.push('---')
  lines.push(
    'Classify the intent_class of the inquiry above. Return ONLY the JSON object.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator — defensive parsing.
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  ok: false
  error: string
}

export interface ValidationSuccess {
  ok: true
  output: InquiryIntentJudgeOutput
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

const VALID_INTENTS: readonly InquiryIntentClass[] = ['targeted', 'broadcast', 'validation']

export function validateInquiryIntentOutput(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  const intentRaw = raw.intent_class
  let intent: InquiryIntentClass | null
  if (intentRaw === null || intentRaw === undefined) {
    intent = null
  } else if (isString(intentRaw) && (VALID_INTENTS as readonly string[]).includes(intentRaw)) {
    intent = intentRaw as InquiryIntentClass
  } else {
    return {
      ok: false,
      error: `intent_class must be "targeted" | "broadcast" | "validation" | null (got ${JSON.stringify(intentRaw)})`,
    }
  }

  const confRaw = raw.confidence_0_100
  if (!isNumber(confRaw)) return { ok: false, error: 'confidence_0_100 must be a number' }
  const confidence = Math.max(0, Math.min(100, Math.round(confRaw)))

  const reasoning = raw.reasoning
  if (!isString(reasoning)) return { ok: false, error: 'reasoning must be a string' }

  const refusalRaw = raw.refusal
  let refusal: string | null = null
  if (refusalRaw === null || refusalRaw === undefined) {
    refusal = null
  } else if (isString(refusalRaw)) {
    const trimmed = refusalRaw.trim()
    refusal = trimmed.length > 0 ? trimmed : null
  } else {
    return { ok: false, error: 'refusal must be string|null' }
  }

  if (intent !== null && refusal !== null) {
    return {
      ok: false,
      error: 'intent_class and refusal are mutually exclusive — exactly one must be null',
    }
  }
  if (intent === null && refusal === null) {
    return {
      ok: false,
      error: 'either intent_class or refusal must be populated',
    }
  }

  return {
    ok: true,
    output: { intent_class: intent, confidence_0_100: confidence, reasoning, refusal },
  }
}
