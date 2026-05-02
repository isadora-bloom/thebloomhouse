/**
 * T3-C: Negotiation-state classifier (Playbook INS-19.3.4).
 *
 * Classifies a wedding into one of 5 phases based on its recent
 * inbound interactions:
 *
 *   early_research      — initial inquiries, gathering info, no
 *                         specific commitments
 *   active_evaluation   — comparing venues, asking specific questions,
 *                         touring (or scheduled to)
 *   late_decision       — has toured, weighing options, asking
 *                         pricing / contract details, decision near
 *   negotiation         — actively negotiating terms, requesting
 *                         changes to the proposal, multiple touchpoints
 *                         on contract specifics
 *   pending_contract    — proposal accepted in spirit, awaiting
 *                         signature / first payment
 *
 * The classification is per-wedding, cached by (most-recent-inbound
 * timestamp + count of recent interactions), so it auto-refreshes on
 * a new inbound but doesn't re-call the LLM on every page render.
 *
 * Surfaces:
 *   - Phase badge on /intel/clients/[id] couple profile
 *   - Phase fed into inquiry-brain prompt assembly so drafts adapt
 *     ("active_evaluation" gets a tour-confirming nudge,
 *      "negotiation" gets an empathy-acknowledge response, etc.)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence } from './types'

export const NEGOTIATION_STATE_PROMPT_VERSION = 'negotiation-state.prompt.v1.0'

export type NegotiationPhase =
  | 'early_research'
  | 'active_evaluation'
  | 'late_decision'
  | 'negotiation'
  | 'pending_contract'

const PHASE_LABEL: Record<NegotiationPhase, string> = {
  early_research: 'Early research',
  active_evaluation: 'Active evaluation',
  late_decision: 'Late decision',
  negotiation: 'Negotiation',
  pending_contract: 'Pending contract',
}

const PHASE_PRIORITY: Record<NegotiationPhase, number> = {
  early_research: 30,
  active_evaluation: 50,
  late_decision: 70,
  negotiation: 85,
  pending_contract: 95,
}

interface ClassicalNegotiationPayload {
  weddingId: string
  status: string
  inbound_count: number
  outbound_count: number
  most_recent_inbound_at: string | null
  recent_subjects: string[]
  recent_excerpts: string[]
}

interface ClassifierResult {
  phase: NegotiationPhase
  reasoning: string
  /** 0..1 — how confident the classifier is. Drives the Insight
   *  confidence column. */
  confidence: number
}

/**
 * Pull the inputs the classifier needs. Last 8 inbound interactions
 * are enough — phase classification is sensitive to recency, not
 * volume.
 */
async function loadClassicalNegotiationEvidence(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<{ payload: ClassicalNegotiationPayload } | null> {
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, status')
    .eq('id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!wedding) return null

  // Skip terminal weddings — phase doesn't apply.
  const status = (wedding.status as string) ?? 'inquiry'
  if (status === 'lost' || status === 'cancelled' || status === 'completed' || status === 'booked') {
    return null
  }

  const { data: inbound } = await supabase
    .from('interactions')
    .select('subject, body_preview, full_body, timestamp')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: false })
    .limit(8)

  const inboundList = (inbound ?? []) as Array<{
    subject: string | null
    body_preview: string | null
    full_body: string | null
    timestamp: string | null
  }>

  if (inboundList.length === 0) return null

  const { count: outboundCount } = await supabase
    .from('interactions')
    .select('id', { count: 'exact', head: true })
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')

  const recentSubjects = inboundList
    .map((i) => (i.subject ?? '').slice(0, 100))
    .filter((s) => s.length > 0)
    .slice(0, 8)

  const recentExcerpts = inboundList
    .map((i) => (i.body_preview ?? i.full_body ?? '').slice(0, 240).trim())
    .filter((s) => s.length > 0)
    .slice(0, 5)

  return {
    payload: {
      weddingId,
      status,
      inbound_count: inboundList.length,
      outbound_count: outboundCount ?? 0,
      most_recent_inbound_at: inboundList[0]?.timestamp ?? null,
      recent_subjects: recentSubjects,
      recent_excerpts: recentExcerpts,
    },
  }
}

async function loadAiName(supabase: SupabaseClient, venueId: string): Promise<string> {
  const { data } = await supabase
    .from('venue_ai_config')
    .select('ai_name')
    .eq('venue_id', venueId)
    .maybeSingle()
  return ((data?.ai_name as string | undefined)?.trim()) || 'your assistant'
}

export async function generateNegotiationState(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  force: boolean = false,
  /** T5-eta.3: forensic-chain correlation id, persists onto the
   *  intelligence_insights row alongside the same id in api_costs. */
  correlationId: string | null = null,
): Promise<{
  phase: NegotiationPhase
  phase_label: string
  reasoning: string
  confidence: number
  cached: boolean
} | null> {
  const evidence = await loadClassicalNegotiationEvidence(supabase, venueId, weddingId)
  if (!evidence) return null
  const { payload } = evidence

  const cacheKey = buildCacheKey({
    weddingId,
    status: payload.status,
    inboundCount: payload.inbound_count,
    mostRecent: payload.most_recent_inbound_at,
  })

  if (!force) {
    const cached = await lookupCachedInsight(supabase, venueId, 'negotiation_state', weddingId, cacheKey)
    if (cached) {
      const dp = cached.data_points as { phase?: NegotiationPhase; reasoning?: string }
      const phase = dp.phase
      if (phase && PHASE_LABEL[phase]) {
        return {
          phase,
          phase_label: PHASE_LABEL[phase],
          reasoning: dp.reasoning ?? cached.body,
          confidence: cached.confidence,
          cached: true,
        }
      }
    }
  }

  const aiName = await loadAiName(supabase, venueId)
  const subjectsBlock = payload.recent_subjects.map((s) => `  - ${s}`).join('\n')
  const excerptsBlock = payload.recent_excerpts.map((s, i) => `  [${i + 1}] ${s}`).join('\n\n')

  const systemPrompt = `You are ${aiName}, a wedding-venue concierge classifying a couple's
negotiation phase based on their recent inbound emails. Output JSON with:
  - phase: one of 'early_research' | 'active_evaluation' | 'late_decision'
           | 'negotiation' | 'pending_contract'
  - reasoning: 1 short sentence (max ~30 words). Reference the SHAPE of
    their messages, not specific numbers.
  - confidence: 0.0 to 1.0 — how strong the signal is. Default 0.5
    when ambiguous; higher when phase is unmistakable.

PHASE GUIDELINES:
  - early_research: gathering info, generic questions, no specific commitments
  - active_evaluation: comparing venues, asking specific questions about
                       availability, budget fit, capacity, touring scheduled or done
  - late_decision: post-tour, weighing options, asking about pricing /
                   contract / next steps, decision near
  - negotiation: actively requesting changes to proposal, multiple
                 touchpoints on contract specifics, "can you do X for Y price"
  - pending_contract: accepted in spirit, awaiting signature / payment.
                      "Send the contract!" "We're ready to book!"

RULES:
- Don't invent quotes from the couple; reference their messages by
  shape ('they asked about pricing', 'they followed up after the tour').
- Don't make up numbers. The classifier doesn't reference numbers.
- Be honest: when the signal is weak, set confidence low and pick
  the most-likely phase, don't hedge.`

  const userPrompt = `WEDDING NEGOTIATION CLASSIFICATION

Wedding status: ${payload.status}
Inbound emails on file: ${payload.inbound_count}
Outbound replies: ${payload.outbound_count}
Most recent inbound: ${payload.most_recent_inbound_at ?? '?'}

Recent inbound subjects:
${subjectsBlock || '  (no subjects)'}

Recent inbound excerpts:
${excerptsBlock || '  (no body content)'}

Classify the phase.`

  let result: ClassifierResult | null = null
  // Cost-ceiling gate (T5-α.2). Status-mapped fallback below.
  const gate = await gateForBrainCall(venueId)
  if (gate.ok) {
    try {
      const raw = await callAIJson<ClassifierResult>({
        systemPrompt,
        userPrompt,
        maxTokens: 220,
        temperature: 0.2,
        venueId,
        taskType: 'negotiation_state',
        tier: 'sonnet',
        promptVersion: NEGOTIATION_STATE_PROMPT_VERSION,
      })
      if (raw && PHASE_LABEL[raw.phase as NegotiationPhase]) {
        result = {
          phase: raw.phase as NegotiationPhase,
          reasoning: (raw.reasoning ?? '').trim() || 'Phase inferred from recent inbound shape.',
          confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
        }
      }
    } catch (err) {
      // PII redaction — prompt carries recent inbound subjects + excerpts.
      // OPS-21.3.3.
      console.warn('[negotiation-state] classifier failed:', redactError(err))
    }
  }

  // Deterministic fallback — map status to a phase when LLM
  // unavailable. Conservative: always 'low' confidence so the badge
  // shows "?".
  if (!result) {
    const fallbackPhase: NegotiationPhase = payload.status === 'proposal_sent'
      ? 'late_decision'
      : payload.status === 'tour_completed'
      ? 'late_decision'
      : payload.status === 'tour_scheduled'
      ? 'active_evaluation'
      : 'early_research'
    result = {
      phase: fallbackPhase,
      reasoning: 'Phase inferred from wedding status (LLM classifier unavailable).',
      confidence: 0.3,
    }
  }

  const classical: ClassicalEvidence = {
    cacheKey,
    numbers: [payload.inbound_count, payload.outbound_count],
    payload: {
      ...payload,
      phase: result.phase,
      reasoning: result.reasoning,
      llm_confidence: result.confidence,
    },
    sampleSize: payload.inbound_count,
    effectSize: result.confidence,
  }
  const conf = confidenceFor({ sampleSize: payload.inbound_count, effectSize: result.confidence })

  await persistInsight(supabase, {
    venueId,
    insightType: 'negotiation_state',
    contextId: weddingId,
    category: 'lead_conversion',
    surfaceLayer: 'inline',
    classical,
    narration: {
      title: `Phase: ${PHASE_LABEL[result.phase]}`,
      body: result.reasoning,
      action: null,  // phase is informational; actions come from inquiry-brain consuming it
    },
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: NEGOTIATION_STATE_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: PHASE_PRIORITY[result.phase],
    priority: result.phase === 'pending_contract' || result.phase === 'negotiation' ? 'high'
      : result.phase === 'late_decision' ? 'medium'
      : 'low',
    correlationId,
  })

  return {
    phase: result.phase,
    phase_label: PHASE_LABEL[result.phase],
    reasoning: result.reasoning,
    confidence: conf.value,
    cached: false,
  }
}
