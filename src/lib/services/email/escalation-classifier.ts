/**
 * Bloom House — Haiku escalation classifier.
 *
 * Anchor docs:
 *   - bloom-may9-llm-vs-template.md (LLM is the primitive)
 *   - feedback_deep_fix_vs_bandaid.md Pattern 1
 *
 * Two-stage detection:
 *   1. Regex fast-path on subject + body. If matches → return immediately
 *      (no LLM cost, reason = 'magic_words' or 'regex_match').
 *   2. Otherwise call Haiku. ~$0.0002 per inbound.
 *
 * Pure function — caller persists the result to the row.
 */

import { callAI, type ContentTier } from '@/lib/ai/client'
import {
  ESCALATION_DETECTOR_PROMPT_VERSION,
  buildEscalationDetectorSystemPrompt,
  buildEscalationDetectorUserPrompt,
  validateEscalationDetectorOutput,
} from '@/config/prompts/escalation-detector'
import { logEvent } from '@/lib/observability/logger'
import {
  HUMAN_REQUESTED_SUBJECT_PATTERN,
  HUMAN_ESCALATION_PATTERN,
} from './pipeline'

export interface ClassifyEscalationInput {
  venueId: string
  aiName: string
  subject: string | null
  body: string
  correlationId?: string
}

export interface ClassifyEscalationResult {
  escalation_requested: boolean
  reason: 'magic_words' | 'haiku_detected' | null
  confidence_0_100: number
  prompt_version: string | null
}

function stripFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

/**
 * The deterministic escalation layer (2026-09-14 ingestion audit item 5).
 *
 * Two patterns, both owned by the pipeline module:
 *   - HUMAN_REQUESTED_SUBJECT_PATTERN: the legacy magic-words form, still
 *     honoured on any thread whose footer asked for it.
 *   - HUMAN_ESCALATION_PATTERN: the broadened natural-language form.
 *
 * Exported so the property test can assert it directly: for any input
 * where this returns a hit, classifyEscalation returns
 * escalation_requested = true regardless of what the model says.
 */
export function detectEscalationDeterministic(
  subject: string,
  body: string,
): { hit: boolean; confidence: number } {
  if (HUMAN_REQUESTED_SUBJECT_PATTERN.test(subject)) {
    return { hit: true, confidence: 100 }
  }
  if (HUMAN_ESCALATION_PATTERN.test(`${subject}\n${body}`)) {
    return { hit: true, confidence: 95 }
  }
  return { hit: false, confidence: 0 }
}

export async function classifyEscalation(
  input: ClassifyEscalationInput,
): Promise<ClassifyEscalationResult> {
  const { venueId, aiName, subject, body, correlationId } = input
  const subj = subject ?? ''

  // 2026-09-14 ingestion audit item 5. The deterministic layer runs
  // FIRST and its verdict is monotone: the model may add an escalation,
  // it can never take one away.
  //
  // This was already true by accident — the regexes returned early, so
  // the model never saw a regex-positive message. Accidental properties
  // do not survive refactors, so it is now explicit: `deterministic` is
  // computed once and OR-ed into every return path below. Reorder the
  // function however you like; the property holds.
  const deterministic = detectEscalationDeterministic(subj, body ?? '')

  if (deterministic.hit) {
    return {
      escalation_requested: true,
      reason: 'magic_words',
      confidence_0_100: deterministic.confidence,
      prompt_version: null,
    }
  }

  // Slow path: Haiku judgement. Tier 2 content (couple PII may appear
  // in body). Fire-and-forget — never block pipeline.
  let aiResult
  try {
    aiResult = await callAI({
      systemPrompt: buildEscalationDetectorSystemPrompt(),
      userPrompt: buildEscalationDetectorUserPrompt({
        subject,
        body,
        aiName,
      }),
      maxTokens: 200,
      temperature: 0.1,
      venueId,
      taskType: 'escalation_detect',
      tier: 'haiku',
      contentTier: 2 as ContentTier,
      promptVersion: ESCALATION_DETECTOR_PROMPT_VERSION,
      correlationId,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'escalation_classifier ai call failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'escalation.classify',
      outcome: 'fail',
      data: { error: err instanceof Error ? err.message : String(err) },
    })
    return {
      escalation_requested: deterministic.hit,
      reason: deterministic.hit ? 'magic_words' : null,
      confidence_0_100: deterministic.confidence,
      prompt_version: null,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(aiResult.text))
  } catch {
    return {
      escalation_requested: deterministic.hit,
      reason: deterministic.hit ? 'magic_words' : null,
      confidence_0_100: deterministic.confidence,
      prompt_version: ESCALATION_DETECTOR_PROMPT_VERSION,
    }
  }

  const validation = validateEscalationDetectorOutput(parsed)
  if (!validation.ok) {
    return {
      escalation_requested: deterministic.hit,
      reason: deterministic.hit ? 'magic_words' : null,
      confidence_0_100: deterministic.confidence,
      prompt_version: ESCALATION_DETECTOR_PROMPT_VERSION,
    }
  }

  // Monotone union. The model adds; it never subtracts. A model that
  // returned false on a deterministic hit is overruled here rather than
  // relied on to have never seen the message.
  const escalated = deterministic.hit || validation.output.escalation_requested
  return {
    escalation_requested: escalated,
    reason: escalated
      ? (deterministic.hit ? 'magic_words' : 'haiku_detected')
      : null,
    confidence_0_100: deterministic.hit
      ? Math.max(deterministic.confidence, validation.output.confidence_0_100)
      : validation.output.confidence_0_100,
    prompt_version: ESCALATION_DETECTOR_PROMPT_VERSION,
  }
}
