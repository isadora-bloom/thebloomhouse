/**
 * Bloom House - Wave 26 draft-edit learning analyzer.
 *
 * Anchor docs:
 *   - memory/feedback_deep_fix_vs_bandaid.md (LLM-as-primitive doctrine -
 *     one focused Haiku call; do not template the classifier ahead of
 *     it)
 *   - memory/feedback_audit_agents_overclaim.md (the analyzer never
 *     persists silently; every insight produces a draft_edit_insights
 *     audit row even when no learning sink applies)
 *
 * What this service does
 * ----------------------
 * Fires after an operator approves an edited draft. Diffs the operator's
 * approved body against the original Sage body (preserved on the
 * drafts row as original_sage_body), runs a Haiku LLM call to extract
 * insights, and routes each insight to the right sink:
 *
 *   voice_rule / tone_shift          -> voice_preferences   (Wave 20)
 *   content_addition / fact_correction -> knowledge_captures (Wave 19)
 *   structure_change / formatting_change / other -> audit only
 *
 * Every insight writes a draft_edit_insights row regardless of where it
 * landed. The operator UI reads from that table to render the
 * learning toast and the /agent/learning/recent-edits view.
 *
 * Cost: ~$0.005 per edited approval on Haiku.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { callAIJson } from '@/lib/ai/client'
import {
  buildDraftEditLearnerSystemPrompt,
  buildDraftEditLearnerUserPrompt,
  validateDraftEditLearnerOutput,
  DRAFT_EDIT_LEARNER_PROMPT_VERSION,
  type DraftEditInsight,
  type DraftEditInsightKind,
  type DraftEditLearnerOutput,
} from '@/config/prompts/draft-edit-learner'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AnalyzeDraftEditInput {
  draftId: string
  venueId: string
  /** What Sage originally wrote. Required - if missing, the analyzer is a no-op. */
  originalSageBody: string | null | undefined
  /** What the operator approved. */
  editedBody: string
  /** Optional: inbound subject for analyzer context. */
  inboundSubject?: string | null
  /** Optional: correlation id to thread the LLM cost log. */
  correlationId?: string | null
  /** Optional supabase override (tests). */
  supabase?: SupabaseClient
}

export interface PersistedInsight {
  insightRowId: string
  kind: DraftEditInsightKind
  learningSummary: string
  sageExcerpt: string
  operatorExcerpt: string
  persistedTo: 'voice_preferences' | 'knowledge_captures' | 'draft_edit_insights_only' | 'discarded'
  persistedRef: string | null
  confidence: number
}

export interface AnalyzeDraftEditResult {
  /** True if the analyzer ran. False if it was a no-op (e.g. no original body, or bodies identical). */
  ran: boolean
  /** Reason the analyzer skipped (only set when ran=false). */
  skippedReason?: string
  /** All insights captured (including discarded / audit-only). */
  insights: PersistedInsight[]
  /** Total cost of the Haiku call. */
  cost: number
  /** Raw analyzer output (mostly for debug / test assertion). */
  rawOutput?: DraftEditLearnerOutput
}

// ---------------------------------------------------------------------------
// Trivial-diff shortcut
// ---------------------------------------------------------------------------

function normalizeForCompare(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function isTrivialDiff(original: string, edited: string): boolean {
  return normalizeForCompare(original) === normalizeForCompare(edited)
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Map an insight kind to its canonical sink. The LLM's recommended_persistence
 *  is a hint; this function is the source of truth. */
function sinkForKind(
  kind: DraftEditInsightKind,
): 'voice_preferences' | 'knowledge_captures' | 'draft_edit_insights_only' {
  switch (kind) {
    case 'voice_rule':
    case 'tone_shift':
      return 'voice_preferences'
    case 'content_addition':
    case 'fact_correction':
      return 'knowledge_captures'
    case 'structure_change':
    case 'formatting_change':
    case 'other':
    default:
      return 'draft_edit_insights_only'
  }
}

// ---------------------------------------------------------------------------
// Voice preferences persistence (Wave 20 pattern)
// ---------------------------------------------------------------------------

/** Heuristic: if operator_excerpt is empty (pure deletion) and sage_excerpt
 *  is short, treat as a banned_phrase. If sage_excerpt is empty and
 *  operator_excerpt is short, treat as an approved_phrase. Otherwise the
 *  insight is a swap - record both rule edges. */
async function persistVoicePref(
  sb: SupabaseClient,
  venueId: string,
  insight: DraftEditInsight,
): Promise<string | null> {
  const sage = insight.sage_excerpt.trim()
  const op = insight.operator_excerpt.trim()

  // Pure deletion: operator removed sage's phrase.
  if (sage && !op && sage.length <= 200) {
    return upsertVoicePref(sb, venueId, 'banned_phrase', sage, insight)
  }

  // Pure addition: operator inserted a phrase Sage didn't have.
  if (op && !sage && op.length <= 200) {
    return upsertVoicePref(sb, venueId, 'approved_phrase', op, insight)
  }

  // Swap: record the sage side as banned and the operator side as approved.
  // The voice prompt prefers both rules. Pick the more compact side first.
  if (sage && op && sage.length <= 200 && op.length <= 200) {
    const bannedId = await upsertVoicePref(sb, venueId, 'banned_phrase', sage, insight)
    // Approved side is logged for completeness but the row id we return
    // is the banned one (the primary signal for "do not do this").
    await upsertVoicePref(sb, venueId, 'approved_phrase', op, insight)
    return bannedId
  }

  // Excerpt too long for a banned/approved phrase row. Fall back to
  // a 'rule' row with the learning_summary as the rule content.
  return upsertVoicePref(sb, venueId, 'rule', insight.learning_summary, insight)
}

async function upsertVoicePref(
  sb: SupabaseClient,
  venueId: string,
  prefType: 'banned_phrase' | 'approved_phrase' | 'rule',
  content: string,
  insight: DraftEditInsight,
): Promise<string | null> {
  try {
    const trimmed = content.trim().slice(0, 500)
    if (!trimmed) return null
    // upsert on (venue_id, preference_type, content) which is the
    // existing unique constraint from migration 005.
    const { data, error } = await sb
      .from('voice_preferences')
      .upsert(
        {
          venue_id: venueId,
          preference_type: prefType,
          content: trimmed,
          score: insight.confidence_0_100 / 100,
          sample_count: 1,
          source_type: 'conversation',
          source_reference: 'draft_edit_insights (Wave 26)',
          confidence_flag: 'live',
        },
        {
          onConflict: 'venue_id,preference_type,content',
          ignoreDuplicates: false,
        },
      )
      .select('id')
      .maybeSingle()

    if (error) {
      console.warn('[draft-learning] voice_preferences upsert failed:', error.message)
      return null
    }
    return (data as { id?: string } | null)?.id ?? null
  } catch (err) {
    console.warn('[draft-learning] voice_preferences upsert threw:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Knowledge capture persistence (Wave 19 pattern - but lighter than the
// full captureKnowledge() flow because we don't have a structured Q&A
// pair yet, just a content delta).
// ---------------------------------------------------------------------------

async function persistKnowledgeCapture(
  sb: SupabaseClient,
  venueId: string,
  insight: DraftEditInsight,
): Promise<string | null> {
  try {
    // Synthesise a question from the learning_summary so the capture is
    // legible in the knowledge UI. The answer is the operator's
    // content (operator_excerpt) plus the summary for context.
    const question = insight.learning_summary.slice(0, 280)
    const answer = (insight.operator_excerpt || insight.learning_summary).slice(0, 2000)

    // Idempotency: if a capture with this question already exists for
    // this venue, update it; else insert.
    const { data: existing } = await sb
      .from('knowledge_captures')
      .select('id')
      .eq('venue_id', venueId)
      .ilike('question', question)
      .limit(1)
      .maybeSingle()

    if ((existing as { id?: string } | null)?.id) {
      const { error: updErr } = await sb
        .from('knowledge_captures')
        .update({
          answer,
          confidence_0_100: insight.confidence_0_100,
          active: true,
        })
        .eq('id', (existing as { id: string }).id)
      if (updErr) {
        console.warn('[draft-learning] knowledge_captures update failed:', updErr.message)
        return null
      }
      return (existing as { id: string }).id
    }

    const { data: ins, error: insErr } = await sb
      .from('knowledge_captures')
      .insert({
        venue_id: venueId,
        question,
        answer,
        source_kind: 'inferred_from_past_email',
        tags: [insight.kind],
        confidence_0_100: insight.confidence_0_100,
        active: true,
      })
      .select('id')
      .single()

    if (insErr || !ins) {
      console.warn('[draft-learning] knowledge_captures insert failed:', insErr?.message)
      return null
    }
    return (ins as { id: string }).id
  } catch (err) {
    console.warn('[draft-learning] knowledge_captures threw:', err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/** Run the analyzer, persist insights to the appropriate sinks, and
 *  write a draft_edit_insights row per insight (audit-of-learnings).
 *
 *  Never throws on persistence failure - returns partial results so the
 *  approve-flow continues. The diff analyzer itself can throw if the
 *  LLM call fails; the caller (approve handler) wraps it in try/catch.
 */
export async function analyzeAndPersistDraftEdit(
  input: AnalyzeDraftEditInput,
): Promise<AnalyzeDraftEditResult> {
  const sb = input.supabase ?? createServiceClient()

  if (!input.originalSageBody) {
    return { ran: false, skippedReason: 'no original_sage_body', insights: [], cost: 0 }
  }
  if (!input.editedBody || input.editedBody === input.originalSageBody) {
    return { ran: false, skippedReason: 'bodies identical', insights: [], cost: 0 }
  }
  if (isTrivialDiff(input.originalSageBody, input.editedBody)) {
    return { ran: false, skippedReason: 'trivial whitespace diff', insights: [], cost: 0 }
  }

  // Look up the venue's AI name (graceful default 'Sage').
  let aiName = 'Sage'
  try {
    const { data: cfg } = await sb
      .from('venue_ai_config')
      .select('ai_name')
      .eq('venue_id', input.venueId)
      .maybeSingle()
    const n = (cfg as { ai_name?: string | null } | null)?.ai_name
    if (n && typeof n === 'string') aiName = n
  } catch {
    /* fall back to 'Sage' */
  }

  // Fire the Haiku analyzer.
  const systemPrompt = buildDraftEditLearnerSystemPrompt()
  const userPrompt = buildDraftEditLearnerUserPrompt({
    ai_name: aiName,
    inbound_subject: input.inboundSubject ?? null,
    original_sage_body: input.originalSageBody,
    edited_body: input.editedBody,
  })

  let analyzerOutput: DraftEditLearnerOutput | null = null
  let cost = 0

  try {
    const raw = await callAIJson<unknown>({
      systemPrompt,
      userPrompt,
      tier: 'haiku',
      maxTokens: 1500,
      temperature: 0.2,
      venueId: input.venueId,
      taskType: 'draft-edit-learner',
      promptVersion: DRAFT_EDIT_LEARNER_PROMPT_VERSION,
      correlationId: input.correlationId ?? undefined,
      contentTier: 2,
    })
    const validated = validateDraftEditLearnerOutput(raw)
    if (!validated.ok) {
      console.warn('[draft-learning] analyzer output failed validation:', validated.error)
      return {
        ran: true,
        insights: [],
        cost,
        skippedReason: `validation: ${validated.error}`,
      }
    }
    analyzerOutput = validated.output
  } catch (err) {
    console.warn('[draft-learning] analyzer LLM call failed:', err)
    return { ran: true, insights: [], cost, skippedReason: 'llm_error' }
  }

  if (!analyzerOutput || analyzerOutput.insights.length === 0) {
    return { ran: true, insights: [], cost, rawOutput: analyzerOutput ?? undefined }
  }

  // Persist each insight to the right sink + write the audit row.
  const persisted: PersistedInsight[] = []
  for (const ins of analyzerOutput.insights) {
    const sink = sinkForKind(ins.kind)
    let persistedRef: string | null = null
    let persistedTo: PersistedInsight['persistedTo'] = sink

    // Discard low-confidence insights (LLM said it's noise).
    if (ins.confidence_0_100 < 40) {
      persistedTo = 'discarded'
    } else if (sink === 'voice_preferences') {
      persistedRef = await persistVoicePref(sb, input.venueId, ins)
      if (!persistedRef) persistedTo = 'draft_edit_insights_only'
    } else if (sink === 'knowledge_captures') {
      persistedRef = await persistKnowledgeCapture(sb, input.venueId, ins)
      if (!persistedRef) persistedTo = 'draft_edit_insights_only'
    }

    // Write the audit row.
    try {
      const { data: auditRow, error: auditErr } = await sb
        .from('draft_edit_insights')
        .insert({
          draft_id: input.draftId,
          venue_id: input.venueId,
          insight_kind: ins.kind,
          sage_text: ins.sage_excerpt || null,
          operator_text: ins.operator_excerpt || null,
          learning_summary: ins.learning_summary,
          persisted_to: persistedTo,
          persisted_ref: persistedRef,
          confidence_0_100: ins.confidence_0_100,
          operator_visible: true,
        })
        .select('id')
        .single()

      if (auditErr || !auditRow) {
        console.warn('[draft-learning] audit insert failed:', auditErr?.message)
        continue
      }

      persisted.push({
        insightRowId: (auditRow as { id: string }).id,
        kind: ins.kind,
        learningSummary: ins.learning_summary,
        sageExcerpt: ins.sage_excerpt,
        operatorExcerpt: ins.operator_excerpt,
        persistedTo,
        persistedRef,
        confidence: ins.confidence_0_100,
      })
    } catch (err) {
      console.warn('[draft-learning] audit insert threw:', err)
    }
  }

  return {
    ran: true,
    insights: persisted,
    cost,
    rawOutput: analyzerOutput,
  }
}
