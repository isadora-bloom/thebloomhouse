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

export async function classifyEscalation(
  input: ClassifyEscalationInput,
): Promise<ClassifyEscalationResult> {
  const { venueId, aiName, subject, body, correlationId } = input
  const subj = subject ?? ''
  const haystack = `${subj}\n${body ?? ''}`

  // Fast path 1: legacy magic-words form. Still works on any thread
  // where the older footer asked for them.
  if (HUMAN_REQUESTED_SUBJECT_PATTERN.test(subj)) {
    return {
      escalation_requested: true,
      reason: 'magic_words',
      confidence_0_100: 100,
      prompt_version: null,
    }
  }

  // Fast path 2: broadened regex. Same reason ('magic_words') so the
  // pipeline routes both identically; the LLM is reserved for ambiguous
  // cases that don't match either regex.
  if (HUMAN_ESCALATION_PATTERN.test(haystack)) {
    return {
      escalation_requested: true,
      reason: 'magic_words',
      confidence_0_100: 95,
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
      escalation_requested: false,
      reason: null,
      confidence_0_100: 0,
      prompt_version: null,
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(aiResult.text))
  } catch {
    return {
      escalation_requested: false,
      reason: null,
      confidence_0_100: 0,
      prompt_version: ESCALATION_DETECTOR_PROMPT_VERSION,
    }
  }

  const validation = validateEscalationDetectorOutput(parsed)
  if (!validation.ok) {
    return {
      escalation_requested: false,
      reason: null,
      confidence_0_100: 0,
      prompt_version: ESCALATION_DETECTOR_PROMPT_VERSION,
    }
  }

  return {
    escalation_requested: validation.output.escalation_requested,
    reason: validation.output.escalation_requested ? 'haiku_detected' : null,
    confidence_0_100: validation.output.confidence_0_100,
    prompt_version: ESCALATION_DETECTOR_PROMPT_VERSION,
  }
}
