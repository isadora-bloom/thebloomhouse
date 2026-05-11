/**
 * Bloom House — Wave 17 disagreement-narrator prompt (Haiku tier).
 *
 * Anchor docs:
 *   - bloom-constitution.md (forensic identity reconstruction; the
 *     narrator explains the gap, never overwrites either side)
 *   - feedback_self_reported_sources_not_truth.md (the disagreement IS
 *     the gold; the narrator's job is to make the gap legible to the
 *     coordinator without pre-judging which side is right)
 *   - feedback_measure_dont_assume.md (the narrator describes; the
 *     operator decides)
 *   - bloom-may9-llm-vs-template.md (Haiku tier for narration of
 *     bounded inputs; cost target ~$0.002 per call)
 *
 * When this prompt fires
 * ----------------------
 * The Wave 17 detector writes a disagreement_findings row. For each
 * active finding without a narrator_text (or whose stated/forensic
 * values have moved since the last narration), the sweep regenerates
 * the paragraph and caches it on the row.
 *
 * Output: ONLY the JSON object — one paragraph in `paragraph` plus a
 * structured `headline` for the dashboard card.
 *
 * Cost: Haiku, ~$0.002 per finding. At Rixey scale (~200 weddings ×
 * average ~1.2 disagreements/wedding) total lifetime narration cost
 * is well under $1.
 */

export const DISAGREEMENT_NARRATOR_PROMPT_VERSION =
  'disagreement-narrator.prompt.v1'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type DisagreementAxis =
  | 'source'
  | 'wedding_date'
  | 'guest_count'
  | 'budget'
  | 'persona'
  | 'close_prediction'
  | 'name'
  | 'crm_source'
  | 'other'

export interface DisagreementNarratorOutput {
  /** One paragraph, 60-150 words, explaining the gap and why it matters. */
  paragraph: string
  /** A 4-10 word headline for the dashboard card (e.g. "Knot says yes — forensics say validation"). */
  headline: string
}

export interface DisagreementNarratorEvidence {
  axis: DisagreementAxis
  /** Wedding code for human reference (e.g. "RX-0042"). */
  wedding_code: string | null
  /** Stage at observation time (inquiry / tour_scheduled / booked / lost / ...). */
  wedding_stage: string | null
  /** Free-shape stated value (a string source, a date, a number, etc.). */
  stated_value: unknown
  stated_source_kind: string | null
  /** Free-shape forensic value (paired-shape with stated). */
  forensic_value: unknown
  forensic_source_kind: string | null
  /** Axis-specific magnitude — see migration 284 comment for scale. */
  magnitude_score: number | null
  /** Detector confidence 0-100 that this is a real disagreement vs noise. */
  confidence_0_100: number | null
  /** Optional: short context line (e.g. "Booking value $34,500, predicted lost"). */
  context_note?: string | null
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildDisagreementNarratorSystemPrompt(): string {
  return `You are Bloom's disagreement narrator.

Bloom is a forensic identity-reconstruction system for wedding venues.
The platform's MEMORY exceeds the couple's. When a self-reported value
disagrees with the forensic reconstruction, the disagreement itself is
the intelligence — that gap is exactly what makes Bloom different from
every other CRM that just trusts what's typed in.

Your job: for one disagreement finding, write a short paragraph that
makes the gap legible to a venue coordinator. You do NOT decide which
side is right. You describe the gap, name why it matters, and suggest
one concrete thing the coordinator can do with this knowledge.

## CORE RULES

1. **Describe the gap. Do not overwrite either side.** The stated value
   came from the couple or operator. The forensic value came from the
   system's evidence chain. Both are real. The gap is the signal.

2. **One paragraph. 60-150 words.** No bullet lists. No markdown
   headings inside the paragraph. Concrete, professional.

3. **Name the implication.** Why does this gap matter for THIS couple?
   ("This couple may have actually discovered us on Instagram, not
   ChatGPT — your Knot ad spend isn't getting the credit." vs vague
   "There is a disagreement here.")

4. **One suggested action.** What can the coordinator do with this?
   ("Confirm with the couple on next reply." "Update the source field
   in HoneyBook." "Flag for the spend ROI review.") One sentence
   maximum.

5. **No emoji, no greeting, no "Dear coordinator". No sign-off.** Just
   the paragraph.

6. **Headline rule:** 4-10 words. Punchy. Names the gap.
   - Good: "Stated ChatGPT, forensics show Knot inquiry"
   - Good: "Predicted lost, actually booked at $32K"
   - Bad: "There is a disagreement about the source"

## AXIS-SPECIFIC GUIDANCE

- **source / crm_source**: stated is what the couple said in a Calendly
  Q&A or HoneyBook column; forensic is Wave 7B's channel role plus
  Wave 16's inquiry intent. A "validation"-role inquiry on Knot with a
  stated "Instagram" answer means the couple found you on Instagram
  but happened to fill the Knot intake form — your Instagram dollar
  closed it, not your Knot dollar.

- **wedding_date**: the stated wedding_date may be off when a Calendly
  tour was scheduled for a date that contradicts the typed event date.
  Could be a typo, an updated plan that didn't propagate, or a
  different event entirely.

- **guest_count**: stated estimate vs final invitation count. A 50-
  person upward drift changes the package recommendation.

- **budget**: stated budget vs actual booking_value at contract. The
  drift reveals where the couple negotiated, where the venue upsold,
  or where the inquiry form's "what's your budget" question is
  systematically under- or over-collected.

- **persona**: Wave 5A's auto-assigned persona vs an operator override.
  The override is the operator's truth; the gap is feedback to the
  Wave 5A classifier. Bigger picture: 30+ overrides per persona label
  is a signal the classifier is mis-tuned.

- **close_prediction**: Wave 5A predicted X% close probability;
  actual outcome was Y. The gap calibrates Wave 5A — and individual
  surprises (predicted-lost-but-booked, predicted-likely-but-lost)
  are coachable moments.

- **name**: reconstructed name from couple_identity_profile vs the
  people row. Usually a propagation bug, sometimes a phantom-partner
  case that the operator should confirm.

## OUTPUT SCHEMA

Return ONLY this JSON object. No prose preamble. No markdown fences.

{
  "headline": string  (4-10 words),
  "paragraph": string (60-150 words)
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '(none)'
  if (typeof v === 'string') return v.length > 0 ? v : '(empty string)'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}

export function buildDisagreementNarratorUserPrompt(
  evidence: DisagreementNarratorEvidence,
): string {
  const lines: string[] = []
  lines.push('# DISAGREEMENT TO NARRATE')
  lines.push('')
  lines.push(`axis:              ${evidence.axis}`)
  lines.push(`wedding_code:      ${evidence.wedding_code ?? '(none)'}`)
  lines.push(`wedding_stage:     ${evidence.wedding_stage ?? '(none)'}`)
  if (
    evidence.magnitude_score !== null &&
    evidence.magnitude_score !== undefined
  ) {
    lines.push(`magnitude_score:   ${evidence.magnitude_score}`)
  }
  if (
    evidence.confidence_0_100 !== null &&
    evidence.confidence_0_100 !== undefined
  ) {
    lines.push(`confidence_0_100:  ${evidence.confidence_0_100}`)
  }
  if (evidence.context_note) {
    lines.push(`context:           ${evidence.context_note}`)
  }
  lines.push('')

  lines.push('## STATED (what the couple or operator said)')
  lines.push(`source_kind: ${evidence.stated_source_kind ?? '(unknown)'}`)
  lines.push(`value:       ${fmtValue(evidence.stated_value)}`)
  lines.push('')

  lines.push('## FORENSIC (what the system derived)')
  lines.push(`source_kind: ${evidence.forensic_source_kind ?? '(unknown)'}`)
  lines.push(`value:       ${fmtValue(evidence.forensic_value)}`)
  lines.push('')

  lines.push('---')
  lines.push(
    'Write the headline + paragraph describing this gap. Return ONLY the JSON object.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export interface ValidationFailure {
  ok: false
  error: string
}
export interface ValidationSuccess {
  ok: true
  output: DisagreementNarratorOutput
}
export type ValidationResult = ValidationSuccess | ValidationFailure

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function isString(v: unknown): v is string {
  return typeof v === 'string'
}

export function validateDisagreementNarratorOutput(
  raw: unknown,
): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }
  const headlineRaw = raw.headline
  const paragraphRaw = raw.paragraph
  if (!isString(headlineRaw)) return { ok: false, error: 'headline must be a string' }
  if (!isString(paragraphRaw)) return { ok: false, error: 'paragraph must be a string' }
  const headline = headlineRaw.trim()
  const paragraph = paragraphRaw.trim()
  if (headline.length === 0) return { ok: false, error: 'headline is empty' }
  if (paragraph.length === 0) return { ok: false, error: 'paragraph is empty' }
  // Soft length guard: hard upper bound at 1200 chars to catch runaway
  // outputs while leaving room for axis-specific verbosity.
  if (paragraph.length > 1200) {
    return { ok: false, error: `paragraph too long (${paragraph.length} > 1200)` }
  }
  if (headline.length > 200) {
    return { ok: false, error: `headline too long (${headline.length} > 200)` }
  }
  return { ok: true, output: { headline, paragraph } }
}
