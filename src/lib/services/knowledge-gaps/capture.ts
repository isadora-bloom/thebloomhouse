/**
 * Bloom House — Wave 19 knowledge-capture service.
 *
 * Anchor docs:
 *   - bloom-constitution.md (operator authority — captures are
 *     authoritative, LLM never overrides)
 *   - memory/feedback_deep_fix_vs_bandaid.md Pattern 8 (close the
 *     loop: detect → capture → fold-in)
 *
 * What this service does
 * ----------------------
 * Records an operator-authored answer into knowledge_captures (the
 * canonical answer store) and marks the source knowledge_gaps row as
 * captured. Idempotent: re-capturing the same gap UPDATES the existing
 * capture rather than inserting a duplicate.
 *
 * Multi-venue: every insert is venue-scoped via the caller. No row
 * crosses tenant boundary.
 *
 * Operator authority: confidence defaults to 100 because the operator
 * IS the authoritative source. Inferred captures (Wave 19+) can sit
 * lower until confirmed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'

export interface CaptureKnowledgeInput {
  venueId: string
  /** Optional gap row this capture answers. If present, the gap row is marked captured. */
  knowledgeGapId?: string | null
  /** The plainly-phrased question (will be the canonical key on dedupe). */
  question: string
  /** Operator-authored answer. */
  answer: string
  /** Optional category tags ('pricing' | 'policies' | etc.). */
  tags?: string[]
  /** Optional expiry timestamp (seasonal / time-bounded policies). */
  appliesUntil?: Date | string | null
  /** Where this capture came from. Defaults to 'operator_input'. */
  sourceKind?: 'operator_input' | 'inferred_from_past_email' | 'venue_doc'
  /** Confidence for non-operator captures. Operator default is 100. */
  confidence?: number
  /** user_profiles.id — the coordinator who provided the answer. */
  operatorId?: string | null
  /** Inject a supabase client (test path); defaults to service-role. */
  supabase?: SupabaseClient
}

export interface CaptureKnowledgeResult {
  captureId: string
  /** True when an existing capture row was updated rather than inserted. */
  reused: boolean
}

/**
 * Capture an operator-authored answer. Idempotent on (venue_id, question)
 * — re-capturing the same question UPDATES the existing capture row
 * (preserves its id so any references stay live).
 */
export async function captureKnowledge(
  input: CaptureKnowledgeInput,
): Promise<CaptureKnowledgeResult> {
  const {
    venueId,
    knowledgeGapId,
    question,
    answer,
    tags,
    appliesUntil,
    sourceKind,
    confidence,
    operatorId,
    supabase,
  } = input

  if (!venueId) throw new Error('captureKnowledge: venueId required')
  if (!question || !question.trim()) {
    throw new Error('captureKnowledge: question required')
  }
  if (!answer || !answer.trim()) {
    throw new Error('captureKnowledge: answer required')
  }

  const sb = supabase ?? createServiceClient()
  const normalisedQuestion = question.trim()
  const normalisedAnswer = answer.trim()
  const tagList = Array.isArray(tags) ? tags.filter((t) => typeof t === 'string') : []
  const resolvedConfidence =
    typeof confidence === 'number' && Number.isFinite(confidence)
      ? Math.max(0, Math.min(100, Math.round(confidence)))
      : 100
  const resolvedSource = sourceKind ?? 'operator_input'
  const resolvedAppliesUntil =
    appliesUntil instanceof Date
      ? appliesUntil.toISOString()
      : typeof appliesUntil === 'string' && appliesUntil.length > 0
        ? appliesUntil
        : null

  // Idempotency lookup. Match on (venue_id, lowercased question). The
  // table is small per-venue so case-insensitive ilike is cheap.
  const { data: existingRow } = await sb
    .from('knowledge_captures')
    .select('id, active')
    .eq('venue_id', venueId)
    .ilike('question', normalisedQuestion)
    .limit(1)
    .maybeSingle()

  const existing = existingRow as { id: string; active: boolean } | null

  let captureId: string
  let reused = false

  if (existing) {
    // Update existing capture: refresh answer + tags + reactivate.
    const { error: updErr } = await sb
      .from('knowledge_captures')
      .update({
        question: normalisedQuestion,
        answer: normalisedAnswer,
        tags: tagList,
        source_kind: resolvedSource,
        confidence_0_100: resolvedConfidence,
        applies_until: resolvedAppliesUntil,
        active: true,
        created_by: operatorId ?? null,
        knowledge_gap_id: knowledgeGapId ?? null,
      })
      .eq('id', existing.id)
    if (updErr) {
      throw new Error(`captureKnowledge update failed: ${updErr.message}`)
    }
    captureId = existing.id
    reused = true
  } else {
    const { data: ins, error: insErr } = await sb
      .from('knowledge_captures')
      .insert({
        venue_id: venueId,
        knowledge_gap_id: knowledgeGapId ?? null,
        question: normalisedQuestion,
        answer: normalisedAnswer,
        tags: tagList,
        source_kind: resolvedSource,
        confidence_0_100: resolvedConfidence,
        applies_until: resolvedAppliesUntil,
        active: true,
        created_by: operatorId ?? null,
      })
      .select('id')
      .single()
    if (insErr || !ins) {
      throw new Error(
        `captureKnowledge insert failed: ${insErr?.message ?? 'no row returned'}`,
      )
    }
    captureId = (ins as { id: string }).id
  }

  // Mark the gap row as captured. Best-effort: if the gap update fails
  // the capture still exists; coordinator can re-link later.
  if (knowledgeGapId) {
    try {
      await sb
        .from('knowledge_gaps')
        .update({
          status: 'resolved',
          resolution: normalisedAnswer,
          resolved_at: new Date().toISOString(),
          captured_at: new Date().toISOString(),
          captured_id: captureId,
        })
        .eq('id', knowledgeGapId)
        .eq('venue_id', venueId)
    } catch {
      // Swallow — capture is the authoritative store; gap row is
      // detector audit. Re-link is recoverable.
    }
  }

  return { captureId, reused }
}

/**
 * Dismiss a knowledge_gaps row as noise (not a real question worth
 * capturing). Mirrors the capture flow's structure for symmetry.
 */
export async function dismissKnowledgeGap(input: {
  venueId: string
  knowledgeGapId: string
  reason: string
  operatorId?: string | null
  supabase?: SupabaseClient
}): Promise<{ ok: boolean }> {
  const { venueId, knowledgeGapId, reason, supabase } = input
  if (!venueId) throw new Error('dismissKnowledgeGap: venueId required')
  if (!knowledgeGapId) throw new Error('dismissKnowledgeGap: knowledgeGapId required')

  const sb = supabase ?? createServiceClient()
  const { error } = await sb
    .from('knowledge_gaps')
    .update({
      status: 'resolved',
      dismissed_at: new Date().toISOString(),
      dismissed_reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
    })
    .eq('id', knowledgeGapId)
    .eq('venue_id', venueId)
  if (error) throw new Error(`dismissKnowledgeGap failed: ${error.message}`)
  return { ok: true }
}
