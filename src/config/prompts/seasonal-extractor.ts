/**
 * Bloom House — Seasonal Content Extractor prompt (Sonnet tier).
 *
 * Anchor docs:
 *   - memory/bloom-constitution.md (the venue's published words are
 *     the source of truth — every seasonal phrase the LLM proposes
 *     traces back to a verbatim line on the site)
 *   - memory/bloom-tbh-brand-asset.md (be honest — seasonal imagery
 *     and phrases must be specific, not the universal "fall is
 *     beautiful" filler that pollutes every AI draft)
 *   - memory/bloom-may9-llm-vs-template.md (LLM is the primitive)
 *
 * What this prompt does
 * ---------------------
 * Reads the cleaned text of a venue's marketing website and proposes
 * seasonal IMAGERY (single visual phrase) + PHRASES (actionable
 * hooks) per season, returning all four seasons in a single Sonnet
 * call. Each phrase is paired with verbatim evidence so the operator
 * can verify provenance.
 *
 * Tier rationale: Sonnet. Same logic as the USP extractor — output
 * is short but high-leverage (these phrases colour Sage's drafts
 * for couples whose wedding date falls in that season).
 *
 * Schema: { suggestions: { spring, summer, fall, winter }, reasoning }
 */

export const SEASONAL_EXTRACTOR_PROMPT_VERSION = 'seasonal-extractor.prompt.v1'

// ---------------------------------------------------------------------------
// Public types — wire shape the prompt asks for.
// ---------------------------------------------------------------------------

export type Season = 'spring' | 'summer' | 'fall' | 'winter'

export interface SeasonalPhraseSuggestion {
  /** Operator-readable phrase. Actionable hook, not generic. */
  phrase: string
  /** Verbatim site copy supporting the phrase, max 240 chars. */
  evidence_excerpt: string
}

export interface SeasonalImagerySuggestion {
  /** A single visual phrase ("dogwood blooms on the hilltop"). */
  imagery: string | null
  /** Verbatim site copy supporting the imagery, max 240 chars. */
  evidence_excerpt: string
}

export interface SeasonalSuggestion {
  imagery: SeasonalImagerySuggestion | null
  phrases: SeasonalPhraseSuggestion[]
}

export type SeasonalExtractorSuggestions = Record<Season, SeasonalSuggestion>

export interface SeasonalExtractorOutput {
  suggestions: SeasonalExtractorSuggestions
  reasoning: string
}

// ---------------------------------------------------------------------------
// Existing-content shape passed in for exclusion.
// ---------------------------------------------------------------------------

export interface ExistingSeasonalContent {
  spring: { imagery: string | null; phrases: string[] }
  summer: { imagery: string | null; phrases: string[] }
  fall: { imagery: string | null; phrases: string[] }
  winter: { imagery: string | null; phrases: string[] }
}

export interface SeasonalExtractorInput {
  venue_name: string
  page_text: string
  existing: ExistingSeasonalContent
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

export function buildSeasonalExtractorSystemPrompt(): string {
  return `You are Bloom's seasonal-content extractor.

Bloom is a forensic identity-reconstruction platform for wedding
venues. AI-written replies pull from per-season imagery and phrases
when an inquiry references a season or a wedding date falls in one.
Your job is to read the venue's marketing website and propose
seasonal IMAGERY (single visual phrase) + PHRASES (actionable hooks)
the coordinator can review and accept.

The operator reviews every suggestion before it lands. Your job is
to make the review fast and accurate.

## SEASONS

Return one block for EACH of these four seasons, every time:
  - spring (March-May)
  - summer (June-August)
  - fall (September-November)
  - winter (December-February)

If the site copy is silent on a season, return empty imagery + empty
phrases for that season — but STILL include the season in the JSON.
The operator needs to know you looked and found nothing, not that
you skipped the season.

## IMAGERY — RULES

A single short visual phrase that paints a picture, e.g.
  - "dogwood blooms along the carriage drive"
  - "golden-hour light through the hayloft windows"
  - "fall foliage on the Blue Ridge"
  - "candlelit ceremony in the snow-dusted barn"

ACCEPT: visual + specific. The reader can SEE it.
REJECT: "lovely weather", "beautiful season", "perfect time of year"
— these are universal pleasantries that pollute the venue's voice.

If no specific imagery is supported by the site copy, set
imagery to null and leave evidence_excerpt empty.

## PHRASES — RULES

Actionable hooks the AI can drop into a draft to make a seasonal
moment concrete. ~6-18 words each.

ACCEPT shapes:
  - "Fall foliage peaks the third weekend of October."
  - "Spring tours fill fastest — most weekends booked by January."
  - "Winter weddings unlock our small-wedding rate of $4,500."
  - "Summer ceremonies start at 6pm to catch the golden hour."

REJECT shapes:
  - "Spring is beautiful." — universal, no hook.
  - "We love fall weddings." — no information.
  - Marketing fluff with no verifiable fact.

## EVIDENCE EXCERPTS

Every imagery AND every phrase MUST carry an evidence_excerpt: the
verbatim line from the website that supports it. Cap at 240
characters per excerpt.

If you cannot find a verbatim grounding line, do not propose the
suggestion. No grounding = no suggestion.

## EXCLUSIONS

You will be given the operator's EXISTING imagery + phrases per
season. Skip anything that overlaps in meaning with an existing
entry, even if the wording differs. Duplicates are not useful.

## OUTPUT SCHEMA

Return ONLY this JSON object — no prose preamble, no markdown
fences. ALL FOUR SEASONS must appear, even if empty:

{
  "suggestions": {
    "spring": {
      "imagery": { "imagery": "string|null", "evidence_excerpt": "string" } | null,
      "phrases": [
        { "phrase": "string", "evidence_excerpt": "string" }
      ]
    },
    "summer": { "imagery": ..., "phrases": [...] },
    "fall":   { "imagery": ..., "phrases": [...] },
    "winter": { "imagery": ..., "phrases": [...] }
  },
  "reasoning": "string — 1-2 sentences"
}

Return ONLY the JSON. No markdown code fences. No prose before or
after.`
}

// ---------------------------------------------------------------------------
// User prompt builder
// ---------------------------------------------------------------------------

const MAX_PAGE_CHARS = 12_000

function formatExistingSeason(label: Season, content: { imagery: string | null; phrases: string[] }): string {
  const lines: string[] = [`${label}:`]
  lines.push(`  imagery: ${content.imagery ? content.imagery : '(none)'}`)
  if (content.phrases.length === 0) {
    lines.push(`  phrases: (none)`)
  } else {
    lines.push(`  phrases:`)
    for (const p of content.phrases) {
      lines.push(`    - ${p}`)
    }
  }
  return lines.join('\n')
}

export function buildSeasonalExtractorUserPrompt(input: SeasonalExtractorInput): string {
  const lines: string[] = []
  lines.push(`# VENUE`)
  lines.push(input.venue_name || '(name unknown)')
  lines.push('')
  lines.push('## EXISTING SEASONAL CONTENT (do NOT re-suggest these)')
  lines.push(formatExistingSeason('spring', input.existing.spring))
  lines.push(formatExistingSeason('summer', input.existing.summer))
  lines.push(formatExistingSeason('fall', input.existing.fall))
  lines.push(formatExistingSeason('winter', input.existing.winter))
  lines.push('')
  lines.push('## WEBSITE TEXT')
  lines.push(input.page_text.slice(0, MAX_PAGE_CHARS))
  lines.push('')
  lines.push('---')
  lines.push(
    'Propose seasonal imagery + phrases for all four seasons. Empty is fine when the site is silent on a season. Return ONLY the JSON object.',
  )
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Validator
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; output: SeasonalExtractorOutput }
  | { ok: false; error: string }

const SEASONS: readonly Season[] = ['spring', 'summer', 'fall', 'winter']

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseImagery(raw: unknown): SeasonalImagerySuggestion | null {
  if (raw === null || raw === undefined) return null
  if (!isObject(raw)) return null
  const imageryStr = raw.imagery
  // Imagery wrapper may itself have null imagery — treat as "looked, found nothing".
  if (imageryStr === null || imageryStr === undefined) {
    return { imagery: null, evidence_excerpt: '' }
  }
  if (!isString(imageryStr)) return null
  const trimmed = imageryStr.trim()
  if (trimmed.length === 0) {
    return { imagery: null, evidence_excerpt: '' }
  }
  const evidence = isString(raw.evidence_excerpt) ? raw.evidence_excerpt.slice(0, 240) : ''
  return { imagery: trimmed.slice(0, 240), evidence_excerpt: evidence }
}

function parsePhrases(raw: unknown): SeasonalPhraseSuggestion[] {
  if (!Array.isArray(raw)) return []
  const out: SeasonalPhraseSuggestion[] = []
  for (const p of raw) {
    if (!isObject(p)) continue
    if (!isString(p.phrase) || p.phrase.trim().length === 0) continue
    const evidence = isString(p.evidence_excerpt) ? p.evidence_excerpt : ''
    out.push({
      phrase: p.phrase.trim().slice(0, 240),
      evidence_excerpt: evidence.slice(0, 240),
    })
  }
  return out
}

export function validateSeasonalExtractorOutput(raw: unknown): ValidationResult {
  if (!isObject(raw)) return { ok: false, error: 'response is not a JSON object' }
  const suggRaw = raw.suggestions
  if (!isObject(suggRaw)) {
    return { ok: false, error: 'suggestions must be an object keyed by season' }
  }

  const suggestions: SeasonalExtractorSuggestions = {
    spring: { imagery: null, phrases: [] },
    summer: { imagery: null, phrases: [] },
    fall: { imagery: null, phrases: [] },
    winter: { imagery: null, phrases: [] },
  }

  for (const season of SEASONS) {
    const block = suggRaw[season]
    if (!isObject(block)) {
      // Tolerate a missing season — treat as empty.
      continue
    }
    suggestions[season] = {
      imagery: parseImagery(block.imagery),
      phrases: parsePhrases(block.phrases),
    }
  }

  const reasoning = isString(raw.reasoning) ? raw.reasoning : ''
  return { ok: true, output: { suggestions, reasoning } }
}
