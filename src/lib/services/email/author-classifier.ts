/**
 * Bloom House — Wave 27 author-class classifier.
 *
 * Anchor docs:
 *   - bloom-constitution.md (author_class is the third dimension on
 *     interactions; same forensic rigor as direction + signal_class)
 *   - bloom-may9-llm-vs-template.md (Haiku for bounded-schema classify;
 *     LLM is the primitive, not heuristics)
 *   - feedback_deep_fix_vs_bandaid.md (class-of-problem fix, not a
 *     Calendly/HoneyBook block list)
 *
 * Pipeline contract
 * -----------------
 * Called post-insert from the email pipeline as fire-and-forget. The
 * row has already landed at author_class='unknown' (or 'operator' for
 * outbound). This service runs the Haiku judge and writes the result
 * back. NEVER throws upstream — the pipeline must keep flowing even
 * when classification fails.
 *
 * Idempotent: re-running over an already-classified row simply
 * overwrites with the latest prompt-version's verdict. The
 * author_class_prompt_version column tracks which prompt the verdict
 * came from so a future prompt bump can re-classify only stale rows.
 *
 * Cost target: ~$0.0003/email on Haiku.
 */

import { callAI, type ContentTier } from '@/lib/ai/client'
import { createServiceClient } from '@/lib/supabase/service'
import {
  AUTHOR_CLASS_PROMPT_VERSION,
  buildAuthorClassSystemPrompt,
  buildAuthorClassUserPrompt,
  validateAuthorClassOutput,
  type AuthorClass,
  type AuthorClassInput,
} from '@/config/prompts/author-class'
import { logEvent } from '@/lib/observability/logger'

export interface ClassifyAuthorInput extends AuthorClassInput {
  venueId: string
  /** The interactions.id this classification will be written back to.
   *  Optional — when omitted, classifyAuthor returns the verdict but
   *  does not persist it (used by the backfill service which writes
   *  back in bulk). */
  interactionId?: string | null
  /** Audit lineage. */
  correlationId?: string | null
}

export interface ClassifyAuthorResult {
  author_class: AuthorClass
  reasoning: string
  promptVersion: string
}

function stripCodeFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

/**
 * Run the Haiku author-class classifier over one email.
 *
 * Never throws. Returns 'unknown' on any error so the caller can keep
 * the existing default in place.
 */
export async function classifyAuthor(
  input: ClassifyAuthorInput,
): Promise<ClassifyAuthorResult> {
  const fallback: ClassifyAuthorResult = {
    author_class: 'unknown',
    reasoning: '',
    promptVersion: AUTHOR_CLASS_PROMPT_VERSION,
  }

  const { venueId, interactionId, correlationId } = input
  if (!venueId) return fallback

  const systemPrompt = buildAuthorClassSystemPrompt()
  const userPrompt = buildAuthorClassUserPrompt({
    from_email: input.from_email,
    from_name: input.from_name,
    subject: input.subject,
    body: input.body,
    extracted_identity: input.extracted_identity,
  })

  let aiResult
  try {
    aiResult = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 200,
      temperature: 0,
      venueId,
      taskType: 'author_class',
      tier: 'haiku',
      contentTier: 2 as ContentTier,
      promptVersion: AUTHOR_CLASS_PROMPT_VERSION,
      correlationId: correlationId ?? undefined,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'author_classifier ai call failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'author_class.classify',
      outcome: 'fail',
      data: { error: err instanceof Error ? err.message : String(err) },
    })
    return fallback
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFences(aiResult.text))
  } catch {
    logEvent({
      level: 'warn',
      msg: 'author_classifier returned non-JSON',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'author_class.classify',
      outcome: 'fail',
      data: { sample: aiResult.text.slice(0, 300) },
    })
    return fallback
  }

  const validation = validateAuthorClassOutput(parsed)
  if (!validation.ok) {
    logEvent({
      level: 'warn',
      msg: 'author_classifier validation failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'author_class.classify',
      outcome: 'fail',
      data: { error: validation.error },
    })
    return fallback
  }

  const result: ClassifyAuthorResult = {
    author_class: validation.output.author_class,
    reasoning: validation.output.reasoning,
    promptVersion: AUTHOR_CLASS_PROMPT_VERSION,
  }

  if (interactionId) {
    try {
      const supabase = createServiceClient()
      await supabase
        .from('interactions')
        .update({
          author_class: result.author_class,
          author_class_prompt_version: result.promptVersion,
          author_class_decided_at: new Date().toISOString(),
        })
        .eq('id', interactionId)
    } catch (err) {
      logEvent({
        level: 'warn',
        msg: 'author_classifier persist failed',
        venueId,
        correlationId: correlationId ?? null,
        actor: 'system',
        event_type: 'author_class.classify',
        outcome: 'fail',
        data: {
          interactionId,
          error: err instanceof Error ? err.message : String(err),
        },
      })
    }
  }

  return result
}
