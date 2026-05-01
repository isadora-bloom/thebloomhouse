/**
 * T3-B: Decay re-engagement insight (Playbook INS-19.3.3).
 *
 * Pre-T3-B the heat-mapping suggestNextAction switch was a template
 * string keyed on `latestEvent + score` — same recommendation regardless
 * of WHY the lead went quiet. Doctrine flagged this as "the generic
 * check-in" anti-pattern.
 *
 * This generator runs a real diagnostic:
 *
 *   CLASSICAL pass:
 *     1. Detect a heat decline change-point — find the most-recent
 *        local maximum in lead_score_history and measure the drop.
 *     2. Find the last inbound interaction; pull its body for the
 *        sentiment / question scan.
 *     3. Locate any UNRESOLVED questions — the inbound body's
 *        '?'-terminated sentences that the venue's last outbound
 *        didn't address (string overlap heuristic).
 *
 *   LLM pass (diagnostic + recommendation):
 *     1. Classify the LIKELY CAUSE: 'missing_info' /
 *        'waiting_on_partner' / 'researching_alternatives' /
 *        'cooling_on_venue' / 'logistics_block' / 'unknown'.
 *     2. Compose a 1-2 sentence recommendation grounded in that
 *        cause + the unresolved questions.
 *
 * Numbers-guard restricts the narration to the heat score, the
 * decline magnitude, and the unresolved-question count — anything
 * else trips a violation.
 *
 * Surfaces:
 *   - LeadInsightsPanel (/intel/clients/[id]) when score declined
 *     ≥15 points OR last inbound > 14 days ago.
 *   - heat-mapping.suggestNextAction can call this and prefer its
 *     output over the template switch (left as follow-up so the
 *     existing switch keeps working as the deterministic fallback).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

export const DECAY_RE_ENGAGEMENT_PROMPT_VERSION = 'decay-re-engagement.prompt.v1.0'

const DAY_MS = 86_400_000

export type DecayCause =
  | 'missing_info'
  | 'waiting_on_partner'
  | 'researching_alternatives'
  | 'cooling_on_venue'
  | 'logistics_block'
  | 'unknown'

const CAUSE_LABEL: Record<DecayCause, string> = {
  missing_info: 'Waiting for info',
  waiting_on_partner: 'Waiting on partner',
  researching_alternatives: 'Comparing venues',
  cooling_on_venue: 'Cooling',
  logistics_block: 'Logistics block',
  unknown: 'Cause unclear',
}

interface ClassicalDecayPayload {
  weddingId: string
  current_score: number
  peak_score: number
  decline_magnitude: number
  decline_started_at: string | null
  days_since_last_inbound: number | null
  last_inbound_excerpt: string | null
  last_outbound_at: string | null
  unresolved_questions: string[]
}

interface DiagnosticResult {
  cause: DecayCause
  reasoning: string
  recommendation: string
  /** 0-1 — confidence in the classification. */
  confidence: number
}

/** Pull a sentence's '?'-terminated tokens. Same shape as
 *  email-pipeline's extractQuestionsFromNote (T1-J B-19). */
function extractQuestions(body: string): string[] {
  if (!body) return []
  return body
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.endsWith('?') && s.length >= 4 && s.length <= 240)
    .slice(0, 5)
}

/** Did the venue's last outbound mention the same words as the
 *  question? Cheap string-overlap heuristic — for true semantic
 *  matching the LLM diagnostic catches it anyway. */
function questionLikelyAddressed(question: string, outboundBody: string): boolean {
  const qWords = new Set(
    question.toLowerCase().split(/\s+/).filter((w) => w.length > 4),
  )
  if (qWords.size === 0) return true  // empty/short question — defer
  const outLower = outboundBody.toLowerCase()
  let hits = 0
  for (const w of qWords) if (outLower.includes(w)) hits++
  // ≥40% of the question's content words → consider it addressed.
  return hits / qWords.size >= 0.4
}

async function loadClassicalDecayEvidence(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<ClassicalDecayPayload | null> {
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, status, heat_score, lost_at')
    .eq('id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!wedding) return null

  const status = (wedding.status as string) ?? 'inquiry'
  if (status === 'lost' || status === 'cancelled' || status === 'completed' || status === 'booked') {
    return null
  }

  const currentScore = (wedding.heat_score as number) ?? 0

  // Heat history — last 60 days. Find the peak score and when the
  // current decline started.
  const sixtyDaysAgo = new Date(Date.now() - 60 * DAY_MS).toISOString()
  const { data: history } = await supabase
    .from('lead_score_history')
    .select('score, calculated_at')
    .eq('wedding_id', weddingId)
    .gte('calculated_at', sixtyDaysAgo)
    .order('calculated_at', { ascending: true })

  let peakScore = currentScore
  let declineStartedAt: string | null = null
  if (history && history.length > 1) {
    let peakIdx = 0
    for (let i = 1; i < history.length; i++) {
      if ((history[i].score as number) > (history[peakIdx].score as number)) peakIdx = i
    }
    peakScore = history[peakIdx].score as number
    if (peakIdx < history.length - 1) {
      // Decline-start = first row after the peak that's lower than peak.
      for (let i = peakIdx + 1; i < history.length; i++) {
        if ((history[i].score as number) < peakScore) {
          declineStartedAt = history[i].calculated_at as string
          break
        }
      }
    }
  }
  const declineMagnitude = Math.max(0, peakScore - currentScore)

  // Last inbound + last outbound for the unresolved-question scan.
  const { data: lastInbound } = await supabase
    .from('interactions')
    .select('subject, body_preview, full_body, timestamp')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: false })
    .limit(1)
  const inboundRow = ((lastInbound ?? []) as Array<{
    subject: string | null
    body_preview: string | null
    full_body: string | null
    timestamp: string | null
  }>)[0]

  const daysSinceLastInbound = inboundRow?.timestamp
    ? Math.round((Date.now() - Date.parse(inboundRow.timestamp)) / DAY_MS)
    : null

  const inboundBody = inboundRow?.full_body ?? inboundRow?.body_preview ?? ''
  const inboundExcerpt = inboundBody.slice(0, 320).trim()

  const { data: lastOutbound } = await supabase
    .from('interactions')
    .select('full_body, body_preview, timestamp')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
    .eq('direction', 'outbound')
    .order('timestamp', { ascending: false })
    .limit(1)
  const outboundRow = ((lastOutbound ?? []) as Array<{
    full_body: string | null
    body_preview: string | null
    timestamp: string | null
  }>)[0]

  const outboundBody = outboundRow?.full_body ?? outboundRow?.body_preview ?? ''

  const allQuestions = extractQuestions(inboundBody)
  const unresolvedQuestions = allQuestions.filter((q) => !questionLikelyAddressed(q, outboundBody))

  return {
    weddingId,
    current_score: currentScore,
    peak_score: peakScore,
    decline_magnitude: declineMagnitude,
    decline_started_at: declineStartedAt,
    days_since_last_inbound: daysSinceLastInbound,
    last_inbound_excerpt: inboundExcerpt || null,
    last_outbound_at: outboundRow?.timestamp ?? null,
    unresolved_questions: unresolvedQuestions,
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

export async function generateDecayReEngagement(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  force: boolean = false,
): Promise<{
  cause: DecayCause
  cause_label: string
  reasoning: string
  recommendation: string
  decline_magnitude: number
  days_since_last_inbound: number | null
  unresolved_questions: string[]
  confidence: number
  cached: boolean
} | null> {
  const classical = await loadClassicalDecayEvidence(supabase, venueId, weddingId)
  if (!classical) return null

  // Surface gating — only fire when there's an actual decay signal.
  // No decline AND recent inbound = no insight (don't pollute the
  // panel with "everything's fine" rows).
  const significantDecline = classical.decline_magnitude >= 15
  const longSilence = (classical.days_since_last_inbound ?? 0) >= 14
  if (!significantDecline && !longSilence) return null

  const cacheKey = buildCacheKey({
    weddingId,
    score: classical.current_score,
    peak: classical.peak_score,
    decline: classical.decline_magnitude,
    daysSilent: classical.days_since_last_inbound,
    unresolvedCount: classical.unresolved_questions.length,
  })

  if (!force) {
    const cached = await lookupCachedInsight(
      supabase, venueId, 'decay_re_engagement', weddingId, cacheKey,
    )
    if (cached) {
      const dp = cached.data_points as Partial<ClassicalDecayPayload> & { cause?: DecayCause; recommendation?: string }
      const cause = (dp.cause as DecayCause) ?? 'unknown'
      return {
        cause,
        cause_label: CAUSE_LABEL[cause] ?? CAUSE_LABEL.unknown,
        reasoning: cached.body,
        recommendation: dp.recommendation ?? cached.action ?? '',
        decline_magnitude: classical.decline_magnitude,
        days_since_last_inbound: classical.days_since_last_inbound,
        unresolved_questions: classical.unresolved_questions,
        confidence: cached.confidence,
        cached: true,
      }
    }
  }

  const aiName = await loadAiName(supabase, venueId)
  const questionsBlock = classical.unresolved_questions.length > 0
    ? classical.unresolved_questions.map((q) => `  - ${q}`).join('\n')
    : '  (none detected)'

  const systemPrompt = `You are ${aiName}, diagnosing why a wedding-venue lead has gone quiet.

Output JSON:
  - cause: one of 'missing_info' | 'waiting_on_partner' | 'researching_alternatives'
           | 'cooling_on_venue' | 'logistics_block' | 'unknown'
  - reasoning: 1 short sentence explaining your diagnosis. Reference the
    SHAPE of evidence (unresolved question, length of silence, decline
    magnitude) — not specific numbers unless they appear in the user prompt.
  - recommendation: 1 sentence with a SPECIFIC re-engagement action
    grounded in the diagnosed cause. NOT a generic check-in. Examples:
      - missing_info → 'Answer their question about the catering policy first.'
      - waiting_on_partner → 'Acknowledge they may need partner alignment; offer
                              flexible reply timing.'
      - researching_alternatives → 'Reinforce the venue's distinguishing
                                    feature — your river-front ceremony spot.'
      - cooling_on_venue → 'Send a soft re-introduction with new photos or a
                            referenced past wedding.'
      - logistics_block → 'Address the logistics blocker directly: parking,
                          shuttle, accessibility, etc.'
  - confidence: 0.0-1.0 — how confident you are in the cause. Default 0.5
    when ambiguous, higher when evidence is unmistakable.

CRITICAL RULES:
- Numbers in your output must come from the user prompt. The only
  numbers you may use are the heat score, the decline magnitude, and
  the days-since-last-inbound count.
- Reference the unresolved question by SHAPE if present ("they asked
  about pricing"); never invent a quote.
- 'missing_info' is the default when unresolved_questions is non-empty
  AND the cause isn't otherwise obvious.
- 'unknown' when evidence is genuinely insufficient — be honest.`

  const userPrompt = `LEAD DECAY DIAGNOSTIC

Current heat score: ${classical.current_score}
Peak heat score (last 60 days): ${classical.peak_score}
Decline magnitude: ${classical.decline_magnitude} points
Decline started: ${classical.decline_started_at ?? 'unclear'}
Days since last inbound: ${classical.days_since_last_inbound ?? 'unknown'}

Unresolved questions from last inbound:
${questionsBlock}

Last inbound excerpt:
${classical.last_inbound_excerpt ?? '(empty)'}

Diagnose the cause + recommend a specific re-engagement action.`

  let result: DiagnosticResult | null = null
  try {
    const raw = await callAIJson<DiagnosticResult>({
      systemPrompt,
      userPrompt,
      maxTokens: 280,
      temperature: 0.3,
      venueId,
      taskType: 'decay_re_engagement',
      tier: 'sonnet',
      promptVersion: DECAY_RE_ENGAGEMENT_PROMPT_VERSION,
    })
    if (raw && CAUSE_LABEL[raw.cause as DecayCause]) {
      result = {
        cause: raw.cause as DecayCause,
        reasoning: (raw.reasoning ?? '').trim() || 'Cause inferred from decay shape.',
        recommendation: (raw.recommendation ?? '').trim() || 'Send a follow-up grounded in their last message.',
        confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      }
    }
  } catch (err) {
    console.warn('[decay-re-engagement] LLM diagnostic failed:', err instanceof Error ? err.message : err)
  }

  // Deterministic fallback — pick from cause heuristics when LLM
  // unavailable. Conservative confidence so the badge shows "?".
  if (!result) {
    let cause: DecayCause = 'unknown'
    let recommendation = 'Send a soft check-in referencing their last message.'
    if (classical.unresolved_questions.length > 0) {
      cause = 'missing_info'
      recommendation = `Answer their pending question first: "${classical.unresolved_questions[0].slice(0, 60)}…"`
    } else if (classical.decline_magnitude >= 30) {
      cause = 'cooling_on_venue'
      recommendation = 'Send a soft re-introduction — new photos or a recent comparable wedding referenced.'
    } else if ((classical.days_since_last_inbound ?? 0) >= 21) {
      cause = 'researching_alternatives'
      recommendation = 'Reinforce the venue\'s distinguishing feature; surface what makes this venue different from comparable options.'
    }
    result = {
      cause,
      reasoning: 'Cause inferred from decay shape (LLM diagnostic unavailable).',
      recommendation,
      confidence: 0.3,
    }
  }

  const allowedNumbers: Array<number | string> = [
    classical.current_score,
    classical.peak_score,
    classical.decline_magnitude,
    classical.days_since_last_inbound ?? 0,
    classical.unresolved_questions.length,
  ]

  const evidence: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: {
      ...classical,
      cause: result.cause,
      reasoning: result.reasoning,
      recommendation: result.recommendation,
      llm_confidence: result.confidence,
    } as unknown as Record<string, unknown>,
    sampleSize: 1 + (classical.days_since_last_inbound ? 1 : 0) + classical.unresolved_questions.length,
    effectSize: result.confidence,
  }
  const conf = confidenceFor({ sampleSize: evidence.sampleSize, effectSize: result.confidence })

  const narration: InsightNarration = {
    title: `Decay diagnosed: ${CAUSE_LABEL[result.cause]}`,
    body: result.reasoning,
    action: result.recommendation,
  }

  await persistInsight(supabase, {
    venueId,
    insightType: 'decay_re_engagement',
    contextId: weddingId,
    category: 'lead_conversion',
    surfaceLayer: classical.decline_magnitude >= 30 ? 'pulse' : 'inline',
    classical: evidence,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: DECAY_RE_ENGAGEMENT_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: classical.decline_magnitude + (classical.days_since_last_inbound ?? 0),
    priority: classical.decline_magnitude >= 40 ? 'high'
      : classical.decline_magnitude >= 20 ? 'medium'
      : 'low',
  })

  return {
    cause: result.cause,
    cause_label: CAUSE_LABEL[result.cause],
    reasoning: result.reasoning,
    recommendation: result.recommendation,
    decline_magnitude: classical.decline_magnitude,
    days_since_last_inbound: classical.days_since_last_inbound,
    unresolved_questions: classical.unresolved_questions,
    confidence: conf.value,
    cached: false,
  }
}
