/**
 * Bloom House — Wave 19 knowledge-gap detect-from-draft.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — every hedge gets
 *     captured so the operator can answer once)
 *   - memory/feedback_deep_fix_vs_bandaid.md Pattern 8 (detect + fix
 *     loop, not detect-and-burn-operator)
 *
 * What this service does
 * ----------------------
 * Given a freshly generated draft + the inbound that triggered it,
 * run a Haiku pass that lists the implicit questions Sage hedged on.
 * Each detected gap becomes a knowledge_gaps row (deduped against
 * existing open gaps for that venue).
 *
 * Cost ~$0.003 per draft. Fire-and-forget: never blocks the brain
 * response path. Errors logged + swallowed.
 */

import { callAI, type ContentTier } from '@/lib/ai/client'
import { createServiceClient } from '@/lib/supabase/service'
import {
  KNOWLEDGE_GAP_DETECTOR_PROMPT_VERSION,
  buildKnowledgeGapDetectorSystemPrompt,
  buildKnowledgeGapDetectorUserPrompt,
  validateKnowledgeGapDetectorOutput,
  type DetectedKnowledgeGap,
} from '@/config/prompts/knowledge-gap-detector'
import { logEvent } from '@/lib/observability/logger'

export interface DetectFromDraftInput {
  venueId: string
  weddingId?: string | null
  draftId?: string | null
  /** Operator-facing AI name (Sage / Lila / Aria / etc.). */
  aiName: string
  inboundSubject: string | null
  inboundBody: string
  draftBody: string
  /** Optional correlation id for audit lineage. */
  correlationId?: string
}

export interface DetectFromDraftResult {
  gaps: DetectedKnowledgeGap[]
  reasoning: string
  /** knowledge_gaps rows inserted (excluding duplicates that already exist). */
  insertedGapIds: string[]
  /** True when the detector chose to skip (e.g. empty draft). */
  skipped: boolean
  skipReason?: string
}

const MIN_DRAFT_CHARS = 80
const MIN_INBOUND_CHARS = 20

/**
 * Strip JSON code fences if Haiku produced any. Defensive — the prompt
 * forbids fences but reality wins arguments.
 */
function stripCodeFences(s: string): string {
  return s
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

export async function detectKnowledgeGapsFromDraft(
  input: DetectFromDraftInput,
): Promise<DetectFromDraftResult> {
  const {
    venueId,
    weddingId,
    draftId,
    aiName,
    inboundSubject,
    inboundBody,
    draftBody,
    correlationId,
  } = input

  if (!venueId) {
    return { gaps: [], reasoning: '', insertedGapIds: [], skipped: true, skipReason: 'no_venue' }
  }
  if (!draftBody || draftBody.trim().length < MIN_DRAFT_CHARS) {
    return {
      gaps: [],
      reasoning: '',
      insertedGapIds: [],
      skipped: true,
      skipReason: 'draft_too_short',
    }
  }
  if (!inboundBody || inboundBody.trim().length < MIN_INBOUND_CHARS) {
    return {
      gaps: [],
      reasoning: '',
      insertedGapIds: [],
      skipped: true,
      skipReason: 'inbound_too_short',
    }
  }

  const systemPrompt = buildKnowledgeGapDetectorSystemPrompt()
  const userPrompt = buildKnowledgeGapDetectorUserPrompt({
    ai_name: aiName,
    inbound_subject: inboundSubject,
    inbound_body: inboundBody,
    draft_body: draftBody,
  })

  let aiResult
  try {
    aiResult = await callAI({
      systemPrompt,
      userPrompt,
      maxTokens: 800,
      temperature: 0.2,
      venueId,
      taskType: 'knowledge_gap_detect',
      tier: 'haiku',
      // Inbound bodies + drafts can contain couple PII. Tier 2.
      contentTier: 2 as ContentTier,
      promptVersion: KNOWLEDGE_GAP_DETECTOR_PROMPT_VERSION,
      correlationId,
    })
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'knowledge_gap_detector ai call failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'knowledge_gap.detect',
      outcome: 'fail',
      data: { error: err instanceof Error ? err.message : String(err) },
    })
    return { gaps: [], reasoning: '', insertedGapIds: [], skipped: true, skipReason: 'ai_error' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFences(aiResult.text))
  } catch {
    logEvent({
      level: 'warn',
      msg: 'knowledge_gap_detector returned non-JSON',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'knowledge_gap.detect',
      outcome: 'fail',
      data: { sample: aiResult.text.slice(0, 300) },
    })
    return { gaps: [], reasoning: '', insertedGapIds: [], skipped: true, skipReason: 'parse_error' }
  }

  const validation = validateKnowledgeGapDetectorOutput(parsed)
  if (!validation.ok) {
    logEvent({
      level: 'warn',
      msg: 'knowledge_gap_detector validation failed',
      venueId,
      correlationId: correlationId ?? null,
      actor: 'system',
      event_type: 'knowledge_gap.detect',
      outcome: 'fail',
      data: { error: validation.error },
    })
    return { gaps: [], reasoning: '', insertedGapIds: [], skipped: true, skipReason: 'validation_error' }
  }

  const { gaps, reasoning } = validation.output

  if (gaps.length === 0) {
    return { gaps: [], reasoning, insertedGapIds: [], skipped: false }
  }

  // Persist each gap. Dedupe against existing open gaps for this venue
  // (case-insensitive question match). Existing gap → bump frequency.
  const supabase = createServiceClient()
  const insertedGapIds: string[] = []

  for (const g of gaps) {
    const normalised = g.question.trim()
    if (normalised.length < 8) continue

    try {
      const { data: existing } = await supabase
        .from('knowledge_gaps')
        .select('id, frequency, status, captured_at, dismissed_at')
        .eq('venue_id', venueId)
        .ilike('question', normalised)
        .limit(1)
        .maybeSingle()

      const ex = existing as {
        id: string
        frequency: number | null
        status: string | null
        captured_at: string | null
        dismissed_at: string | null
      } | null

      if (ex) {
        // Resolved / captured / dismissed gaps don't reopen on a single
        // fresh detection — same logic as recordKnowledgeGaps.
        if (ex.status === 'resolved' || ex.captured_at || ex.dismissed_at) continue
        await supabase
          .from('knowledge_gaps')
          .update({ frequency: (ex.frequency ?? 1) + 1 })
          .eq('id', ex.id)
        insertedGapIds.push(ex.id)
      } else {
        const { data: ins } = await supabase
          .from('knowledge_gaps')
          .insert({
            venue_id: venueId,
            question: normalised,
            category: g.category,
            frequency: 1,
            status: 'open',
          })
          .select('id')
          .single()
        if (ins?.id) insertedGapIds.push(ins.id as string)
      }
    } catch (err) {
      logEvent({
        level: 'warn',
        msg: 'knowledge_gap_detector persist failed',
        venueId,
        correlationId: correlationId ?? null,
        actor: 'system',
        event_type: 'knowledge_gap.detect',
        outcome: 'fail',
        data: {
          error: err instanceof Error ? err.message : String(err),
          question: normalised.slice(0, 100),
        },
      })
    }
  }

  logEvent({
    level: 'info',
    msg: 'knowledge_gap_detector ran',
    venueId,
    correlationId: correlationId ?? null,
    actor: 'system',
    event_type: 'knowledge_gap.detect',
    outcome: 'ok',
    data: {
      draft_id: draftId ?? null,
      wedding_id: weddingId ?? null,
      gaps_detected: gaps.length,
      gaps_persisted: insertedGapIds.length,
      reasoning: reasoning.slice(0, 200),
    },
  })

  return { gaps, reasoning, insertedGapIds, skipped: false }
}
