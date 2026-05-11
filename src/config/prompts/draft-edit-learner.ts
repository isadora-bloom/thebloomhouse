/**
 * Bloom House — Wave 26 draft-edit-learner prompt (Haiku tier).
 *
 * Anchor docs:
 *   - memory/feedback_deep_fix_vs_bandaid.md (LLM-as-primitive — the
 *     diff analyzer is ONE focused Haiku call; do not template the
 *     classifier ahead of it)
 *   - memory/feedback_no_em_dash.md (em-dash removal is a canonical
 *     voice_rule the analyzer will see often; Wave 20 auto-derive
 *     already captured it from corpus, Wave 26's per-edit learner
 *     reinforces operator-specific signal)
 *   - bloom-may9-llm-vs-template.md (every "Sage / AI / smart" label
 *     must be backed by a callAI call — this is the learning surface
 *     for the approval flow)
 *
 * When this prompt fires
 * ----------------------
 * Right after an operator approves a draft, if draft_body !=
 * original_sage_body, the diff analyzer runs. It outputs 1-5 distinct
 * edits the operator made. Each edit gets routed:
 *   - voice_rule, tone_shift          -> voice_preferences (Wave 20)
 *   - content_addition, fact_correction -> knowledge_captures (Wave 19)
 *   - structure_change, formatting_change, other -> audit only
 *
 * Cost target: ~$0.005 per edited approval on Haiku. At Rixey scale
 * (~100 inbound/yr × ~30% editing rate = ~30 edits/yr) that's $0.15/yr.
 * At Wedgewood scale (80 venues × ~30 edits/yr × 80) still under $12/yr
 * total.
 */

export const DRAFT_EDIT_LEARNER_PROMPT_VERSION =
  'draft-edit-learner.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — wire shape the prompt asks for.
// ---------------------------------------------------------------------------

export type DraftEditInsightKind =
  | 'voice_rule'
  | 'content_addition'
  | 'tone_shift'
  | 'structure_change'
  | 'fact_correction'
  | 'formatting_change'
  | 'other'

export type DraftEditPersistenceHint =
  | 'voice_preferences'
  | 'knowledge_captures'
  | 'none'

export interface DraftEditInsight {
  /** Bucket — drives where the insight is persisted. */
  kind: DraftEditInsightKind
  /** Verbatim excerpt from Sage's original draft (max ~280 chars). */
  sage_excerpt: string
  /** Verbatim excerpt from the operator's edited version (max ~280 chars). */
  operator_excerpt: string
  /** Plain 1-sentence description of what was learned. Shown to operator. */
  learning_summary: string
  /** LLM's hint for where the insight should land. The router validates. */
  recommended_persistence: DraftEditPersistenceHint
  /** 0-100 confidence in the learning. */
  confidence_0_100: number
}

export interface DraftEditLearnerOutput {
  insights: DraftEditInsight[]
  /** Concise reasoning - 1-2 sentences. Logged for audit. */
  reasoning: string
}

// ---------------------------------------------------------------------------
// Evidence input
// ---------------------------------------------------------------------------

export interface DraftEditLearnerInput {
  /** Operator-facing AI name (e.g. 'Sage'). */
  ai_name: string
  /** Subject line of the email being responded to. */
  inbound_subject: string | null
  /** What Sage originally wrote. */
  original_sage_body: string
  /** What the operator changed it to. */
  edited_body: string
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildDraftEditLearnerSystemPrompt(): string {
  return `You are Bloom's draft-edit learning analyzer.

Bloom is a forensic identity-reconstruction platform for wedding
venues. The operator just edited a draft ${'Sage'} wrote. Your job is to
extract WHAT changed and WHY it likely matters, so the platform can
learn the operator's voice + knowledge over time.

You will be given the ORIGINAL draft and the EDITED draft. Output 1-5
distinct insights — one per meaningful change. Trivial whitespace
fixes or a single typo correction can be skipped if they carry no
signal. If the edits are entirely trivial, return an empty array.

## INSIGHT KINDS

Each insight gets exactly one kind:

  voice_rule
    The operator changed a phrase / word the writer should ban or
    prefer. Examples: removed an em-dash, swapped "Hi there" for "Hi
    Sarah", deleted a corporate filler ("at our beautiful property"),
    swapped a passive sentence for active. Anything that's a stable
    rule the operator would want applied to FUTURE drafts.

  content_addition
    The operator added information Sage didn't have. Examples: a
    pricing link, a package detail, a vendor recommendation, a piece
    of policy. Anything an operator might add again on the next
    similar email.

  tone_shift
    The operator changed the warmth / formality / hedging without
    changing facts. Examples: made the closing friendlier, shortened
    a verbose paragraph, removed a hedge ("I think we can probably
    accommodate" -> "Yes, we can").

  structure_change
    Reorder of paragraphs, splitting one paragraph into two, merging
    two into one. No new content, no voice change. Just layout.

  fact_correction
    Sage stated something wrong and the operator fixed it. Examples:
    wrong date, wrong package name, wrong capacity number. Different
    from content_addition (which adds NEW information).

  formatting_change
    Whitespace, line breaks, bullet style, paragraph breaks. No
    semantic change.

  other
    Use sparingly. Only when the change is real but doesn't fit any
    bucket above.

## PERSISTENCE ROUTING

For each insight set recommended_persistence:

  voice_preferences
    voice_rule and tone_shift insights. The platform will upsert into
    the voice_preferences table (banned phrases, approved phrases,
    tone descriptors).

  knowledge_captures
    content_addition and fact_correction insights. The platform will
    write to the venue's knowledge_captures store so Sage knows the
    fact next time.

  none
    structure_change, formatting_change, and most "other" insights.
    Logged as audit only; not pushed into any learning sink.

The platform router validates this hint — if you ask for
voice_preferences on a content_addition, the router will override.
Use the hint as a guide; the router is the source of truth.

## CORE RULES

1. **One change per insight.** Do not bundle. If the operator
   removed an em-dash AND added a pricing link AND fixed a date,
   that is THREE insights.

2. **Excerpts are verbatim.** sage_excerpt is copied from the
   original. operator_excerpt is copied from the edited version. Cap
   at 280 characters each. Do not paraphrase. For pure deletions
   (operator removed text and added nothing), operator_excerpt can be
   the empty string. For pure additions, sage_excerpt can be the
   empty string.

3. **Phrase learning_summary plainly.** One sentence. Operator-
   readable. Examples:
     - "Operator prefers no em-dashes; remove them in future drafts."
     - "Operator added a link to the pricing page; include it in
       similar inquiries."
     - "Operator dropped the formal hedge and stated availability
       directly."

4. **No direction-loaded language.** Per Wave 22 doctrine, describe
   what changed neutrally. Avoid "improved", "fixed mistake", "better
   version". Just name the change.

5. **Confidence reflects reuse-likelihood.** 90+ when the change is
   clearly a stable rule ("never use em-dashes"). 60-80 when it
   could be one-off ("dropped the wedding date confirmation because
   the couple already mentioned it"). Below 60 means "low signal,
   probably not worth persisting."

6. **Trivial changes -> empty array.** A whitespace fix, a single
   typo correction, or a comma swap is not a learning. Return
   insights: [] in that case.

7. **Refuse when unclear.** If you can't tell what changed
   meaningfully (very small diff, noisy whitespace), return empty
   array and explain in reasoning. Better silent than wrong.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences:

{
  "insights": [
    {
      "kind": "voice_rule" | "content_addition" | "tone_shift" | "structure_change" | "fact_correction" | "formatting_change" | "other",
      "sage_excerpt": "string - verbatim from original, max 280 chars",
      "operator_excerpt": "string - verbatim from edited, max 280 chars",
      "learning_summary": "string - 1 sentence, neutral, operator-readable",
      "recommended_persistence": "voice_preferences" | "knowledge_captures" | "none",
      "confidence_0_100": 0..100
    }
  ],
  "reasoning": "string - 1-2 sentences explaining the overall diff"
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

export function buildDraftEditLearnerUserPrompt(
  input: DraftEditLearnerInput,
): string {
  const lines: string[] = []
  lines.push(`# DRAFT EDIT TO ANALYSE`)
  lines.push('')
  lines.push(`AI name: ${input.ai_name}`)
  if (input.inbound_subject) {
    lines.push(`Inbound subject: ${input.inbound_subject}`)
  }
  lines.push('')
  lines.push('## ORIGINAL (what Sage wrote)')
  lines.push(input.original_sage_body.slice(0, 4000))
  lines.push('')
  lines.push('## EDITED (what the operator approved)')
  lines.push(input.edited_body.slice(0, 4000))
  lines.push('')
  lines.push('---')
  lines.push(
    'List the distinct insights from this edit. Return ONLY the JSON object.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

const VALID_KINDS: readonly DraftEditInsightKind[] = [
  'voice_rule',
  'content_addition',
  'tone_shift',
  'structure_change',
  'fact_correction',
  'formatting_change',
  'other',
]

const VALID_PERSISTENCE: readonly DraftEditPersistenceHint[] = [
  'voice_preferences',
  'knowledge_captures',
  'none',
]

export interface ValidationFailure {
  ok: false
  error: string
}

export interface ValidationSuccess {
  ok: true
  output: DraftEditLearnerOutput
}

export type ValidationResult = ValidationSuccess | ValidationFailure

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function validateDraftEditLearnerOutput(
  raw: unknown,
): ValidationResult {
  if (!isObject(raw)) {
    return { ok: false, error: 'response is not a JSON object' }
  }

  const insightsRaw = raw.insights
  if (!Array.isArray(insightsRaw)) {
    return { ok: false, error: 'insights must be an array' }
  }

  const insights: DraftEditInsight[] = []
  for (let i = 0; i < insightsRaw.length; i++) {
    const ins = insightsRaw[i]
    if (!isObject(ins)) {
      return { ok: false, error: `insights[${i}] is not an object` }
    }

    const kindRaw = ins.kind
    if (!isString(kindRaw) || !(VALID_KINDS as readonly string[]).includes(kindRaw)) {
      return {
        ok: false,
        error: `insights[${i}].kind invalid (got ${JSON.stringify(kindRaw)})`,
      }
    }

    const sageExcerpt = isString(ins.sage_excerpt) ? ins.sage_excerpt : ''
    const opExcerpt = isString(ins.operator_excerpt) ? ins.operator_excerpt : ''
    const learningSummary = isString(ins.learning_summary) ? ins.learning_summary.trim() : ''
    if (!learningSummary) {
      return {
        ok: false,
        error: `insights[${i}].learning_summary must be a non-empty string`,
      }
    }

    const persistRaw = ins.recommended_persistence
    const persistence: DraftEditPersistenceHint =
      isString(persistRaw) && (VALID_PERSISTENCE as readonly string[]).includes(persistRaw)
        ? (persistRaw as DraftEditPersistenceHint)
        : 'none'

    const conf = typeof ins.confidence_0_100 === 'number'
      ? Math.max(0, Math.min(100, Math.round(ins.confidence_0_100)))
      : 70

    insights.push({
      kind: kindRaw as DraftEditInsightKind,
      sage_excerpt: sageExcerpt.slice(0, 280),
      operator_excerpt: opExcerpt.slice(0, 280),
      learning_summary: learningSummary.slice(0, 500),
      recommended_persistence: persistence,
      confidence_0_100: conf,
    })
  }

  const reasoning = isString(raw.reasoning) ? raw.reasoning.slice(0, 1000) : ''

  return { ok: true, output: { insights, reasoning } }
}
