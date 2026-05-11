/**
 * Bloom House — Content Suggester: seasonal extractor service.
 *
 * Anchor docs:
 *   - memory/bloom-constitution.md (operator authority — every
 *     suggestion is reviewed before it lands in venue_seasonal_content)
 *   - memory/bloom-may9-llm-vs-template.md (LLM is the primitive)
 *
 * Cost: ~$0.012 per call. Sonnet, ~3-5k input tokens, larger output
 * (4 seasons × imagery + phrases). Operator-triggered, 1-3 calls per
 * venue per quarter.
 */

import { callAI, type ContentTier } from '@/lib/ai/client'
import {
  SEASONAL_EXTRACTOR_PROMPT_VERSION,
  buildSeasonalExtractorSystemPrompt,
  buildSeasonalExtractorUserPrompt,
  validateSeasonalExtractorOutput,
  type ExistingSeasonalContent,
  type Season,
  type SeasonalExtractorSuggestions,
  type SeasonalPhraseSuggestion,
} from '@/config/prompts/seasonal-extractor'
import { logEvent } from '@/lib/observability/logger'

export interface ExtractSeasonalInput {
  venueId: string
  venueName: string
  pageText: string
  current: ExistingSeasonalContent
  correlationId?: string
}

export interface ExtractSeasonalResult {
  suggestions: SeasonalExtractorSuggestions
  reasoning: string
  skipped: boolean
  skipReason?: string
}

const MIN_PAGE_CHARS = 200

const EMPTY_SUGGESTIONS: SeasonalExtractorSuggestions = {
  spring: { imagery: null, phrases: [] },
  summer: { imagery: null, phrases: [] },
  fall: { imagery: null, phrases: [] },
  winter: { imagery: null, phrases: [] },
}

function stripCodeFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

function normaliseForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

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

const SEASONS: readonly Season[] = ['spring', 'summer', 'fall', 'winter']

export async function extractSeasonalContent(
  input: ExtractSeasonalInput,
): Promise<ExtractSeasonalResult> {
  const { venueId, venueName, pageText, current, correlationId } = input

  if (!venueId) {
    return { suggestions: EMPTY_SUGGESTIONS, reasoning: '', skipped: true, skipReason: 'no_venue' }
  }
  if (!pageText || pageText.trim().length < MIN_PAGE_CHARS) {
    return {
      suggestions: EMPTY_SUGGESTIONS,
      reasoning: '',
      skipped: true,
      skipReason: 'page_too_short',
    }
  }

  const systemPrompt = buildSeasonalExtractorSystemPrompt()
  const userPrompt = buildSeasonalExtractorUserPrompt({
    venue_name: venueName,
    page_text: pageText,
    existing: current,
  })

  let aiResult
  try {
    aiResult = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 2000,
      temperature: 0.3,
      venueId,
      taskType: 'seasonal_extract',
      tier: 'sonnet',
      contentTier: 3 as ContentTier,
      promptVersion: SEASONAL_EXTRACTOR_PROMPT_VERSION,
      correlationId,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'seasonal_extractor ai call failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'content_suggest.seasonal',
      outcome: 'fail',
      data: { error: err instanceof Error ? err.message : String(err) },
    })
    return {
      suggestions: EMPTY_SUGGESTIONS,
      reasoning: '',
      skipped: true,
      skipReason: 'ai_error',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFences(aiResult.text))
  } catch {
    logEvent({
      level: 'warn',
      msg: 'seasonal_extractor returned non-JSON',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'content_suggest.seasonal',
      outcome: 'fail',
      data: { sample: aiResult.text.slice(0, 300) },
    })
    return {
      suggestions: EMPTY_SUGGESTIONS,
      reasoning: '',
      skipped: true,
      skipReason: 'parse_error',
    }
  }

  const validation = validateSeasonalExtractorOutput(parsed)
  if (!validation.ok) {
    logEvent({
      level: 'warn',
      msg: 'seasonal_extractor validation failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'content_suggest.seasonal',
      outcome: 'fail',
      data: { error: validation.error },
    })
    return {
      suggestions: EMPTY_SUGGESTIONS,
      reasoning: '',
      skipped: true,
      skipReason: 'validation_error',
    }
  }

  // Post-LLM dedup: drop suggestions that overlap with the operator's
  // current rows even if the prompt failed to exclude them.
  const filtered: SeasonalExtractorSuggestions = {
    spring: { imagery: null, phrases: [] },
    summer: { imagery: null, phrases: [] },
    fall: { imagery: null, phrases: [] },
    winter: { imagery: null, phrases: [] },
  }

  for (const season of SEASONS) {
    const block = validation.output.suggestions[season]
    const existingImagery = current[season].imagery
    const existingPhrases = current[season].phrases

    // Imagery: only one slot per season — skip if the LLM's imagery
    // matches the existing imagery (or is empty).
    let newImagery = block.imagery
    if (newImagery && newImagery.imagery) {
      if (existingImagery && isAlreadyCovered(newImagery.imagery, [existingImagery])) {
        newImagery = null
      }
    }

    const newPhrases: SeasonalPhraseSuggestion[] = block.phrases.filter(
      (p) => !isAlreadyCovered(p.phrase, existingPhrases),
    )

    filtered[season] = { imagery: newImagery, phrases: newPhrases }
  }

  logEvent({
    level: 'info',
    msg: 'seasonal_extractor ran',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'content_suggest.seasonal',
    outcome: 'ok',
    data: {
      reasoning: validation.output.reasoning.slice(0, 200),
      counts: {
        spring: filtered.spring.phrases.length,
        summer: filtered.summer.phrases.length,
        fall: filtered.fall.phrases.length,
        winter: filtered.winter.phrases.length,
      },
    },
  })

  return {
    suggestions: filtered,
    reasoning: validation.output.reasoning,
    skipped: false,
  }
}
