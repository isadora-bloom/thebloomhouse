/**
 * Bloom House — Content Suggester: USP extractor service.
 *
 * Anchor docs:
 *   - memory/bloom-constitution.md (operator authority — suggestions
 *     are never auto-written; the operator reviews every one before
 *     it lands in venue_usps)
 *   - memory/bloom-may9-llm-vs-template.md (LLM is the primitive —
 *     this replaces the prior "operator types every USP from scratch"
 *     friction with a Sonnet-grounded suggester)
 *
 * Cost: ~$0.008 per call. Sonnet, ~3-5k input tokens, ~500 output.
 * Operator-triggered (manual button), 1-3 calls per venue per quarter.
 * Negligible at venue scale.
 */

import { callAI, type ContentTier } from '@/lib/ai/client'
import {
  USP_EXTRACTOR_PROMPT_VERSION,
  buildUSPExtractorSystemPrompt,
  buildUSPExtractorUserPrompt,
  validateUSPExtractorOutput,
  type USPSuggestion,
} from '@/config/prompts/usp-extractor'
import { logEvent } from '@/lib/observability/logger'

export interface ExtractUSPsInput {
  venueId: string
  venueName: string
  /** Cleaned page text from fetchVenueHomepage.combinedText. */
  pageText: string
  /** USP rows the operator has already entered for this venue. */
  currentUSPs: string[]
  /** Optional correlation id for audit lineage. */
  correlationId?: string
}

export interface ExtractUSPsResult {
  suggestions: USPSuggestion[]
  reasoning: string
  /** True when the extractor short-circuited (e.g. empty page text). */
  skipped: boolean
  skipReason?: string
}

const MIN_PAGE_CHARS = 200

/** Strip JSON code fences defensively. */
function stripCodeFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

/**
 * Normalise a string for fuzzy duplicate detection. Lowercase, collapse
 * whitespace, strip punctuation. Used to filter out suggestions whose
 * gist the operator already wrote.
 */
function normaliseForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Decide whether `candidate` already overlaps with `existing`. Case-
 * insensitive bidirectional substring match — if the candidate contains
 * any existing entry OR is contained in any existing entry, drop it.
 */
function isAlreadyCovered(candidate: string, existing: string[]): boolean {
  const c = normaliseForDedup(candidate)
  if (!c) return true
  for (const e of existing) {
    const en = normaliseForDedup(e)
    if (!en) continue
    if (c === en) return true
    if (c.includes(en) || en.includes(c)) return true
  }
  return false
}

export async function extractUSPs(input: ExtractUSPsInput): Promise<ExtractUSPsResult> {
  const { venueId, venueName, pageText, currentUSPs, correlationId } = input

  if (!venueId) {
    return { suggestions: [], reasoning: '', skipped: true, skipReason: 'no_venue' }
  }
  if (!pageText || pageText.trim().length < MIN_PAGE_CHARS) {
    return { suggestions: [], reasoning: '', skipped: true, skipReason: 'page_too_short' }
  }

  const systemPrompt = buildUSPExtractorSystemPrompt()
  const userPrompt = buildUSPExtractorUserPrompt({
    venue_name: venueName,
    page_text: pageText,
    existing_usps: currentUSPs,
  })

  let aiResult
  try {
    aiResult = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 1500,
      temperature: 0.3,
      venueId,
      taskType: 'usp_extract',
      tier: 'sonnet',
      // Marketing copy is non-sensitive — operational tier.
      contentTier: 3 as ContentTier,
      promptVersion: USP_EXTRACTOR_PROMPT_VERSION,
      correlationId,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'usp_extractor ai call failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'content_suggest.usp',
      outcome: 'fail',
      data: { error: err instanceof Error ? err.message : String(err) },
    })
    return { suggestions: [], reasoning: '', skipped: true, skipReason: 'ai_error' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFences(aiResult.text))
  } catch {
    logEvent({
      level: 'warn',
      msg: 'usp_extractor returned non-JSON',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'content_suggest.usp',
      outcome: 'fail',
      data: { sample: aiResult.text.slice(0, 300) },
    })
    return { suggestions: [], reasoning: '', skipped: true, skipReason: 'parse_error' }
  }

  const validation = validateUSPExtractorOutput(parsed)
  if (!validation.ok) {
    logEvent({
      level: 'warn',
      msg: 'usp_extractor validation failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'content_suggest.usp',
      outcome: 'fail',
      data: { error: validation.error },
    })
    return { suggestions: [], reasoning: '', skipped: true, skipReason: 'validation_error' }
  }

  // Filter out suggestions that overlap with existing operator-entered
  // USPs. This is the post-LLM safety net — the prompt already asks
  // for exclusion, but the LLM can still propose semantic duplicates.
  const filtered = validation.output.suggestions.filter(
    (s) => !isAlreadyCovered(s.usp_text, currentUSPs),
  )

  logEvent({
    level: 'info',
    msg: 'usp_extractor ran',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'content_suggest.usp',
    outcome: 'ok',
    data: {
      suggestions_raw: validation.output.suggestions.length,
      suggestions_after_dedup: filtered.length,
      reasoning: validation.output.reasoning.slice(0, 200),
    },
  })

  return {
    suggestions: filtered,
    reasoning: validation.output.reasoning,
    skipped: false,
  }
}
