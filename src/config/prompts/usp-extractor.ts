/**
 * Bloom House — USP Extractor prompt (Sonnet tier).
 *
 * Anchor docs:
 *   - memory/bloom-constitution.md (forensic identity; the venue's
 *     own published words are the source of truth — the operator
 *     reviews every suggestion before it lands in venue_usps)
 *   - memory/bloom-tbh-brand-asset.md (be honest — USPs must be
 *     verifiable against the website's own copy, not LLM hallucinations)
 *   - memory/bloom-may9-llm-vs-template.md (the LLM is the primitive
 *     for extracting truth from human signals — the venue's site is
 *     the human signal here)
 *
 * What this prompt does
 * ---------------------
 * Reads the cleaned text of a venue's marketing website and proposes
 * short, venue-SPECIFIC differentiator statements suitable for
 * venue_usps rows. Each proposed USP comes paired with the verbatim
 * excerpt from the page where the evidence was found, so the operator
 * can confirm provenance before accepting.
 *
 * Tier rationale: Sonnet. USPs are short outputs (~6-10 short
 * statements) but they directly shape AI-written replies and brand
 * voice for the venue forever. Haiku's tendency to over-generalise
 * ("beautiful venue", "amazing staff") is exactly the failure mode
 * we're trying to prevent. The cost delta vs Haiku (~$0.008 vs
 * ~$0.001) is negligible against the per-venue operator hour saved.
 *
 * Schema: { suggestions: [{ usp_text, evidence_excerpt, confidence }], reasoning }
 */

export const USP_EXTRACTOR_PROMPT_VERSION = 'usp-extractor.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — wire shape the prompt asks for.
// ---------------------------------------------------------------------------

export interface USPSuggestion {
  /** Operator-readable USP. 8-15 words, venue-specific. */
  usp_text: string
  /** Verbatim excerpt from the website where the USP was inferred. */
  evidence_excerpt: string
  /** 0-1 confidence; conservative — anything below 0.5 should be flagged. */
  confidence: number
}

export interface USPExtractorOutput {
  suggestions: USPSuggestion[]
  /** 1-2 sentences explaining the LLM's overall read of the site. */
  reasoning: string
}

// ---------------------------------------------------------------------------
// Inputs the user prompt serialises.
// ---------------------------------------------------------------------------

export interface USPExtractorInput {
  /** Display name for the venue — orients the LLM. */
  venue_name: string
  /** Cleaned page text from fetchVenueHomepage.combinedText. */
  page_text: string
  /**
   * USP strings the operator has already entered. The extractor must
   * exclude any suggestion whose normalised form already exists here
   * (case-insensitive substring match) — the operator already wrote it.
   */
  existing_usps: string[]
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildUSPExtractorSystemPrompt(): string {
  return `You are Bloom's USP extractor.

Bloom is a forensic identity-reconstruction platform for wedding
venues. The venue's own marketing website is the most reliable
self-portrait it has published. Your job is to read that website
and propose short, venue-SPECIFIC differentiator statements (USPs)
the venue's coordinator can review and accept into the AI's voice
configuration.

These USPs will be blended into AI-written replies to inquiries and
clients. Generic statements pollute the venue's voice; specific
statements give Sage something concrete to say. Operator authority
is preserved — every suggestion you produce is reviewed before it
lands. Your job is to make the operator's review fast and accurate.

## WHAT COUNTS AS A USP

A USP is a SHORT statement (8-15 words) that names something
SPECIFIC the venue offers that another venue probably does not.

ACCEPT shapes:
  - Concrete physical features: "200-year-old stone barn",
    "Blue-Ridge views from the ceremony lawn",
    "200 acres of working farmland", "1906 estate".
  - Specific inclusions: "Every couple gets the whole property
    for the weekend.", "Bridal suite + groom's quarters included".
  - Capacity / scale facts: "Up to 250 seated under the chandeliers".
  - Distinct policies: "BYOB-friendly with no corkage", "One
    wedding at a time, never overlapping events".
  - Distinct services: "On-site farm-to-table catering",
    "Resident horses you can include in portraits".

REJECT shapes (do NOT propose):
  - Universal pleasantries: "beautiful venue", "amazing staff",
    "stunning views", "perfect for your big day".
  - Vague feelings: "we make your day magical", "you'll love it".
  - Marketing fluff without a verifiable fact: "the experience of
    a lifetime".
  - Anything you cannot trace to a verbatim line on the site.

If the site copy is generic and you cannot find specific
differentiators, return an EMPTY suggestions array. Empty is the
right answer when the site has no real USPs — never invent them.

## EVIDENCE EXCERPT

Each suggestion MUST carry an evidence_excerpt: the verbatim phrase
or sentence from the page where you found the supporting fact. Cap
at 240 characters. This is how the operator verifies you didn't
hallucinate.

If you cannot find a verbatim grounding line, do not propose the
USP. No grounding = no suggestion.

## CONFIDENCE

Rate each suggestion 0-1:
  - 0.9-1.0: explicit, repeated, or front-of-homepage fact.
  - 0.7-0.9: clearly stated once.
  - 0.5-0.7: implied but the evidence is one line.
  - Below 0.5: do not propose. The operator review queue is
    expensive — we don't surface low-confidence guesses.

## EXCLUSIONS

You will be given a list of USPs the operator has already entered
under "EXISTING USPs". Skip anything that overlaps in meaning with
an existing entry, even if the wording differs. The operator does
not need duplicates.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown
fences:

{
  "suggestions": [
    {
      "usp_text": "string — 8-15 words, venue-specific",
      "evidence_excerpt": "string — verbatim site copy, max 240 chars",
      "confidence": 0.0-1.0
    }
  ],
  "reasoning": "string — 1-2 sentences"
}

Return ONLY the JSON. No markdown code fences. No prose before or
after.`
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

/** Cap on how much page text we ship to the LLM. ~12k chars ≈ 3k tokens. */
const MAX_PAGE_CHARS = 12_000

export function buildUSPExtractorUserPrompt(input: USPExtractorInput): string {
  const lines: string[] = []
  lines.push(`# VENUE`)
  lines.push(input.venue_name || '(name unknown)')
  lines.push('')
  lines.push('## EXISTING USPs (do NOT re-suggest these)')
  if (input.existing_usps.length === 0) {
    lines.push('(none yet)')
  } else {
    for (const u of input.existing_usps) {
      lines.push(`- ${u}`)
    }
  }
  lines.push('')
  lines.push('## WEBSITE TEXT')
  lines.push(input.page_text.slice(0, MAX_PAGE_CHARS))
  lines.push('')
  lines.push('---')
  lines.push(
    'Propose venue-specific USPs grounded in verbatim site copy. Return ONLY the JSON object.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; output: USPExtractorOutput }
  | { ok: false; error: string }

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function validateUSPExtractorOutput(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }

  const suggRaw = raw.suggestions
  if (!Array.isArray(suggRaw)) {
    return { ok: false, error: 'suggestions must be an array' }
  }

  const suggestions: USPSuggestion[] = []
  for (let i = 0; i < suggRaw.length; i++) {
    const s = suggRaw[i]
    if (!isObject(s)) {
      return { ok: false, error: `suggestions[${i}] is not an object` }
    }
    if (!isString(s.usp_text) || s.usp_text.trim().length === 0) {
      return { ok: false, error: `suggestions[${i}].usp_text must be a non-empty string` }
    }
    const evidence = isString(s.evidence_excerpt) ? s.evidence_excerpt : ''
    let confidence = isNumber(s.confidence) ? s.confidence : 0
    if (confidence < 0) confidence = 0
    if (confidence > 1) confidence = 1
    suggestions.push({
      usp_text: s.usp_text.trim().slice(0, 240),
      evidence_excerpt: evidence.slice(0, 240),
      confidence,
    })
  }

  const reasoning = isString(raw.reasoning) ? raw.reasoning : ''
  return { ok: true, output: { suggestions, reasoning } }
}
