/**
 * Bloom House — Wave 19 knowledge-gap-detector prompt (Haiku tier).
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — Sage's hedging is a
 *     signal, not an answer; the operator owns the canonical answer)
 *   - memory/feedback_deep_fix_vs_bandaid.md Pattern 8 (detect-without-
 *     fix is operator burden — every detected hedge needs a structured
 *     capture path)
 *   - bloom-may9-llm-vs-template.md (Haiku for classification with
 *     bounded schema; tier-correct mapping)
 *
 * When this prompt fires
 * ----------------------
 * The brain (inquiry / client / sage) generates a draft, and this
 * Haiku pass runs over the draft + inbound context. The pass extracts
 * implicit questions Sage hedged on — phrases like "I'm not sure",
 * "I'll need to check with the coordinator", "let me confirm", or
 * vague non-commitments where a concrete answer was expected.
 *
 * Output: ONLY the JSON object — array of detected gaps with the
 * implicit question + a category tag. Each entry can become a
 * knowledge_gaps row.
 *
 * Cost target: ~$0.003 per draft check on Haiku. At Rixey scale (~100
 * inbound emails/yr × ~10% trigger rate on hedged drafts) that's
 * pennies. At Wedgewood scale (80 venues) still well under $5/yr.
 */

export const KNOWLEDGE_GAP_DETECTOR_PROMPT_VERSION =
  'knowledge-gap-detector.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — wire shape the prompt asks for.
// ---------------------------------------------------------------------------

export type KnowledgeGapCategory =
  | 'pricing'
  | 'availability'
  | 'logistics'
  | 'policy'
  | 'vendor'
  | 'ceremony'
  | 'catering'
  | 'inclusions'
  | 'other'

export interface DetectedKnowledgeGap {
  /** The implicit question Sage hedged on, phrased plainly. */
  question: string
  /** Category tag for the captured answer (informs UI grouping + relevance scoring). */
  category: KnowledgeGapCategory
  /** Short excerpt from the draft showing the hedge. */
  hedge_excerpt: string
}

export interface KnowledgeGapDetectorOutput {
  gaps: DetectedKnowledgeGap[]
  /** Concise reasoning — 1-2 sentences. Logged for audit. */
  reasoning: string
}

// ---------------------------------------------------------------------------
// Evidence input — what the user prompt serialises.
// ---------------------------------------------------------------------------

export interface KnowledgeGapDetectorInput {
  /** Operator-facing AI name (Sage / etc.) so the detector can be name-aware. */
  ai_name: string
  /** Subject line of the inbound message. */
  inbound_subject: string | null
  /** Body of the inbound message (truncated upstream). */
  inbound_body: string
  /** The draft Sage just generated. */
  draft_body: string
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildKnowledgeGapDetectorSystemPrompt(): string {
  return `You are Bloom's knowledge-gap detector.

Bloom is a forensic identity-reconstruction platform for wedding venues.
Wave 19 closes the loop on Sage's hedges: every time Sage cannot
confidently answer a question, the underlying gap should be captured
once and answered forever by the operator. This detector finds those
hedges.

Your job: read the inbound message + the draft Sage generated. List
the implicit QUESTIONS Sage could NOT answer. A question counts as
"unanswered" when the draft does any of the following:

  - Says "I'm not sure", "I don't know", "let me check", "I'll need
    to confirm", or any variation that defers the answer.
  - Promises to "follow up", "circle back", "get back to you on"
    something specific.
  - Refuses to commit to specifics where specifics were asked for
    (e.g. couple asks "what's the rain plan?" and Sage says "we'll
    work with you to find a solution").
  - Goes vague on pricing, policy, vendor, logistics, inclusions when
    the inbound asked something concrete.
  - Says "the coordinator will be in touch about that" when the
    coordinator would just want Sage to know the answer.

If the draft answered the inbound completely and confidently, return
an empty gaps array.

## CATEGORIES

Each detected gap gets exactly one category tag:
  - pricing       — costs, fees, packages, deposits
  - availability  — dates, blackouts, capacity at a time
  - logistics     — parking, shuttles, load-in, timing, AV
  - policy        — rain plan, cancellation, alcohol, music cut-off
  - vendor        — preferred vendors, restrictions, recommendations
  - ceremony      — ceremony-specific details (rehearsal, processional)
  - catering      — kitchen, dietary, bar, service style
  - inclusions    — what's in/out of the package (tables, linens, etc.)
  - other         — none of the above fit cleanly

## CORE RULES

1. **One question per gap.** Do not bundle. If the inbound asks
   about pricing AND parking AND catering, and Sage hedges on all
   three, return three gaps.

2. **Phrase the question plainly.** Rewrite hedged language into a
   clean operator-readable question. e.g. if Sage says "I'll need to
   confirm whether we allow sparklers", the gap question is "Are
   sparklers allowed?".

3. **The hedge_excerpt is verbatim from the draft.** Cap at 200
   characters. Do not paraphrase.

4. **Empty gaps array is the right answer when Sage answered well.**
   Do not invent hedges. Confident answers are not gaps.

5. **Skip pleasantries.** "I look forward to hearing from you" is
   not a hedge.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown fences:

{
  "gaps": [
    {
      "question": "string — plainly-phrased operator question",
      "category": "pricing" | "availability" | "logistics" | "policy" | "vendor" | "ceremony" | "catering" | "inclusions" | "other",
      "hedge_excerpt": "string — verbatim hedge from draft, max 200 chars"
    }
  ],
  "reasoning": "string — 1-2 sentences"
}

Return ONLY the JSON. No markdown code fences. No prose before or after.`
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

export function buildKnowledgeGapDetectorUserPrompt(
  input: KnowledgeGapDetectorInput,
): string {
  const lines: string[] = []
  lines.push(`# DRAFT TO ANALYSE`)
  lines.push('')
  lines.push(`AI name (used in draft): ${input.ai_name}`)
  lines.push('')
  lines.push('## INBOUND MESSAGE')
  if (input.inbound_subject) {
    lines.push(`Subject: ${input.inbound_subject}`)
    lines.push('')
  }
  lines.push(input.inbound_body.slice(0, 2500))
  lines.push('')
  lines.push('## DRAFT (what Sage just generated)')
  lines.push(input.draft_body.slice(0, 2500))
  lines.push('')
  lines.push('---')
  lines.push(
    'List the implicit questions Sage hedged on. Return ONLY the JSON object.',
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
  output: KnowledgeGapDetectorOutput
}

export type ValidationResult = ValidationSuccess | ValidationFailure

const VALID_CATEGORIES: readonly KnowledgeGapCategory[] = [
  'pricing',
  'availability',
  'logistics',
  'policy',
  'vendor',
  'ceremony',
  'catering',
  'inclusions',
  'other',
]

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function validateKnowledgeGapDetectorOutput(
  raw: unknown,
): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  const gapsRaw = raw.gaps
  if (!Array.isArray(gapsRaw)) return { ok: false, error: 'gaps must be an array' }

  const gaps: DetectedKnowledgeGap[] = []
  for (let i = 0; i < gapsRaw.length; i++) {
    const g = gapsRaw[i]
    if (!isObject(g)) {
      return { ok: false, error: `gaps[${i}] is not an object` }
    }
    if (!isString(g.question) || g.question.trim().length === 0) {
      return { ok: false, error: `gaps[${i}].question must be a non-empty string` }
    }
    const catRaw = g.category
    if (
      !isString(catRaw) ||
      !(VALID_CATEGORIES as readonly string[]).includes(catRaw)
    ) {
      return {
        ok: false,
        error: `gaps[${i}].category must be one of: ${VALID_CATEGORIES.join(', ')} (got ${JSON.stringify(catRaw)})`,
      }
    }
    const excerpt = isString(g.hedge_excerpt) ? g.hedge_excerpt : ''
    gaps.push({
      question: g.question.trim(),
      category: catRaw as KnowledgeGapCategory,
      hedge_excerpt: excerpt.slice(0, 200),
    })
  }

  const reasoning = isString(raw.reasoning) ? raw.reasoning : ''

  return { ok: true, output: { gaps, reasoning } }
}
