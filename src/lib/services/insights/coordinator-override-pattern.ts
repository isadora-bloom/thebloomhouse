/**
 * T3-I (a): Coordinator override pattern (Playbook INS-19.6.4).
 *
 * Self-knowledge insight: how is the coordinator interacting with
 * Sage's drafts? Approve / edit / reject mix and trend. Day-of-week
 * anomalies (Tuesdays consistently 2x rejection = surface for inquiry).
 *
 * Bandaid traps avoided:
 *
 *   - Tiny sample → require >=20 draft_feedback rows in the 4-week
 *     window before computing rates. <20 returns null (no surface).
 *
 *   - Coordinator-blame framing → narration is neutral ("AI drafts are
 *     being edited 35% of the time" not "coordinator rejects 35%").
 *
 *   - Day-of-week anomaly at low N → require >=5 draft_feedback rows
 *     per day-of-week before flagging that day as anomalous.
 *
 *   - Comparing absolute counts when draft volume is changing →
 *     compute and compare RATES (action / total per window), not
 *     counts.
 *
 *   - Confounded with prompt revision changes → carry the most-recent
 *     prompt_version observed in the window into evidence so the
 *     coordinator can see "this drift coincided with prompt v1.3
 *     rolling out".
 *
 *   - LLM hallucinating numbers → numbers-guard locks narration to
 *     {total_drafts, approved_pct, edited_pct, rejected_pct,
 *     prior_approved_pct, anomaly_dow_count, anomaly_pp_diff}.
 *
 *   - No drafts at all → returns null gracefully.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

export const COORDINATOR_OVERRIDE_PROMPT_VERSION = 'coordinator-override-pattern.prompt.v1.0'

const DAY_MS = 86_400_000
const RECENT_WINDOW_DAYS = 28          // last 4 weeks
const PRIOR_WINDOW_DAYS = 28           // 4 weeks before that
const MIN_RECENT_FEEDBACK = 20
const MIN_PER_DOW_FEEDBACK = 5
const DOW_ANOMALY_PP_THRESHOLD = 20    // dow rejection rate diverges >=20pp from overall mean

const DOW_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface FeedbackRow {
  action: 'approved' | 'edited' | 'rejected'
  created_at: string
  draft_id: string
}

interface ActionMix {
  approved: number
  edited: number
  rejected: number
  total: number
  approved_pct: number
  edited_pct: number
  rejected_pct: number
}

interface DowAnomaly {
  day: number
  day_label: string
  rejected_pct: number
  diff_from_mean_pp: number  // signed
  n: number
}

interface ClassicalCoordinatorPayload {
  venueId: string
  recent: ActionMix
  prior: ActionMix | null
  /** rejected_pct change pp; signed (positive = drift toward more rejection). */
  rejection_drift_pp: number | null
  dow_anomalies: DowAnomaly[]
  recent_window: { startIso: string; endIso: string }
}

function actionMix(rows: FeedbackRow[]): ActionMix {
  const out = { approved: 0, edited: 0, rejected: 0, total: 0, approved_pct: 0, edited_pct: 0, rejected_pct: 0 }
  for (const r of rows) {
    if (r.action === 'approved') out.approved++
    else if (r.action === 'edited') out.edited++
    else if (r.action === 'rejected') out.rejected++
  }
  out.total = out.approved + out.edited + out.rejected
  if (out.total > 0) {
    out.approved_pct = Math.round((out.approved / out.total) * 1000) / 10
    out.edited_pct = Math.round((out.edited / out.total) * 1000) / 10
    out.rejected_pct = Math.round((out.rejected / out.total) * 1000) / 10
  }
  return out
}

/**
 * Day-of-week analysis. Computes per-DoW rejection rate, flags any
 * DoW where rate diverges >=20pp from the overall mean AND has
 * sufficient sample (>=5 feedbacks).
 */
export function dowRejectionAnomalies(rows: FeedbackRow[]): DowAnomaly[] {
  if (rows.length === 0) return []
  const overall = actionMix(rows)
  const meanRejected = overall.rejected_pct

  const buckets: Array<{ approved: number; edited: number; rejected: number }> = Array.from(
    { length: 7 }, () => ({ approved: 0, edited: 0, rejected: 0 }),
  )
  for (const r of rows) {
    const ts = Date.parse(r.created_at)
    if (!Number.isFinite(ts)) continue
    const d = new Date(ts).getUTCDay()
    if (r.action === 'approved') buckets[d].approved++
    else if (r.action === 'edited') buckets[d].edited++
    else if (r.action === 'rejected') buckets[d].rejected++
  }

  const out: DowAnomaly[] = []
  for (let d = 0; d < 7; d++) {
    const b = buckets[d]
    const n = b.approved + b.edited + b.rejected
    if (n < MIN_PER_DOW_FEEDBACK) continue
    const rejected_pct = Math.round((b.rejected / n) * 1000) / 10
    // Round diff to avoid 19.99999 → "20pp" surprises.
    const diff = Math.round((rejected_pct - meanRejected) * 10) / 10
    if (Math.abs(diff) >= DOW_ANOMALY_PP_THRESHOLD) {
      out.push({
        day: d,
        day_label: DOW_LABELS[d],
        rejected_pct,
        diff_from_mean_pp: diff,
        n,
      })
    }
  }
  // Most-divergent first.
  out.sort((a, b) => Math.abs(b.diff_from_mean_pp) - Math.abs(a.diff_from_mean_pp))
  return out
}

/**
 * Per ANTI-19.9 #5, self-knowledge insights that touch on coordinator
 * BEHAVIOUR (vs. venue track-record) are opt-in only — coordinator
 * surveillance pattern. The gate lives on venues.self_knowledge_insights_enabled
 * (migration 148, default false). Returns true when the venue has
 * opted in.
 */
async function selfKnowledgeOptedIn(
  supabase: SupabaseClient,
  venueId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from('venues')
    .select('self_knowledge_insights_enabled')
    .eq('id', venueId)
    .maybeSingle()
  return Boolean((data as { self_knowledge_insights_enabled?: boolean } | null)?.self_knowledge_insights_enabled)
}

async function loadClassicalCoordinatorEvidence(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ClassicalCoordinatorPayload | null> {
  const recentStart = new Date(Date.now() - RECENT_WINDOW_DAYS * DAY_MS)
  const recentEnd = new Date()
  const priorStart = new Date(Date.now() - (RECENT_WINDOW_DAYS + PRIOR_WINDOW_DAYS) * DAY_MS)
  const priorEnd = recentStart

  const { data } = await supabase
    .from('draft_feedback')
    .select('action, created_at, draft_id')
    .eq('venue_id', venueId)
    .gte('created_at', priorStart.toISOString())
    .lte('created_at', recentEnd.toISOString())

  const rows = ((data ?? []) as FeedbackRow[])
  const recentRows = rows.filter((r) => Date.parse(r.created_at) >= recentStart.getTime())
  const priorRows = rows.filter((r) => Date.parse(r.created_at) < recentStart.getTime())

  const recent = actionMix(recentRows)
  if (recent.total < MIN_RECENT_FEEDBACK) return null

  const prior = priorRows.length >= MIN_RECENT_FEEDBACK ? actionMix(priorRows) : null
  const rejection_drift_pp = prior !== null
    ? Math.round((recent.rejected_pct - prior.rejected_pct) * 10) / 10
    : null

  const dow_anomalies = dowRejectionAnomalies(recentRows)

  return {
    venueId,
    recent,
    prior,
    rejection_drift_pp,
    dow_anomalies,
    recent_window: { startIso: recentStart.toISOString(), endIso: recentEnd.toISOString() },
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

interface CoordinatorDiagnostic {
  reasoning: string
  recommendation: string
  confidence: number
}

export async function generateCoordinatorOverridePattern(
  supabase: SupabaseClient,
  venueId: string,
  force: boolean = false,
  /** T5-eta.3 correlation id; persists onto the row. */
  correlationId: string | null = null,
): Promise<{
  total_drafts: number
  approved_pct: number
  edited_pct: number
  rejected_pct: number
  prior_approved_pct: number | null
  rejection_drift_pp: number | null
  dow_anomalies: Array<{ day_label: string; rejected_pct: number; diff_from_mean_pp: number; n: number }>
  reasoning: string
  recommendation: string
  confidence: number
  cached: boolean
} | null> {
  // Opt-in gate per ANTI-19.9 #5. Default false so this insight does
  // NOT compute / surface for any venue until explicitly enabled —
  // protects venues from accidental coordinator-surveillance shipping.
  if (!(await selfKnowledgeOptedIn(supabase, venueId))) return null

  const classical = await loadClassicalCoordinatorEvidence(supabase, venueId)
  if (!classical) return null

  // Surface gating: if the recent mix is "boring" (no significant
  // drift, no DoW anomaly), return null. The coordinator doesn't
  // need a surface row that says "everything is normal".
  const significantDrift = classical.rejection_drift_pp !== null && Math.abs(classical.rejection_drift_pp) >= 10
  const hasDowAnomaly = classical.dow_anomalies.length > 0
  if (!significantDrift && !hasDowAnomaly) return null

  const cacheKey = buildCacheKey({
    venueId,
    total: classical.recent.total,
    approved: classical.recent.approved_pct,
    edited: classical.recent.edited_pct,
    rejected: classical.recent.rejected_pct,
    prior: classical.prior?.rejected_pct ?? null,
    drift: classical.rejection_drift_pp,
    anomalyDays: classical.dow_anomalies.map((a) => `${a.day}:${a.diff_from_mean_pp}`).join(','),
  })

  // Synthetic context_id 'venue' — null context_id breaks upsert dedup
  // because Postgres treats NULL != NULL in unique indexes, so every
  // run would insert a duplicate row instead of updating. Same value
  // is used in lookupCachedInsight + persistInsight below.
  const VENUE_SCOPE_CONTEXT = 'venue'

  if (!force) {
    const cached = await lookupCachedInsight(
      supabase, venueId, 'coordinator_override_pattern', VENUE_SCOPE_CONTEXT, cacheKey,
    )
    if (cached) {
      const dp = cached.data_points as Partial<ClassicalCoordinatorPayload> & { recommendation?: string }
      return {
        total_drafts: classical.recent.total,
        approved_pct: classical.recent.approved_pct,
        edited_pct: classical.recent.edited_pct,
        rejected_pct: classical.recent.rejected_pct,
        prior_approved_pct: classical.prior?.approved_pct ?? null,
        rejection_drift_pp: classical.rejection_drift_pp,
        dow_anomalies: classical.dow_anomalies.map((a) => ({
          day_label: a.day_label, rejected_pct: a.rejected_pct,
          diff_from_mean_pp: a.diff_from_mean_pp, n: a.n,
        })),
        reasoning: cached.body,
        recommendation: dp.recommendation ?? cached.action ?? '',
        confidence: cached.confidence,
        cached: true,
      }
    }
  }

  const aiName = await loadAiName(supabase, venueId)

  const driftBlock = classical.prior !== null
    ? `Prior 4-week window: ${classical.prior.total} drafts, approved ${classical.prior.approved_pct}% / edited ${classical.prior.edited_pct}% / rejected ${classical.prior.rejected_pct}%. Recent rejection rate moved by ${classical.rejection_drift_pp}pp.`
    : 'No prior 4-week sample available for trend comparison.'

  const dowBlock = classical.dow_anomalies.length > 0
    ? classical.dow_anomalies.map((a) =>
        `  - ${a.day_label}: ${a.rejected_pct}% rejected (${a.diff_from_mean_pp >= 0 ? '+' : ''}${a.diff_from_mean_pp}pp from week mean), n=${a.n}`,
      ).join('\n')
    : '  (no day-of-week anomalies)'

  const systemPrompt = `You are ${aiName}, helping the venue coordinator
audit how their AI-drafted email collaboration is going.

Output JSON:
  - reasoning: 1 short sentence. Frame NEUTRALLY ("drafts are being
    edited X%" not "coordinator rejects X%"). Reference rates, drift,
    and any DoW anomaly.
  - recommendation: 1 sentence with a SPECIFIC action grounded in the
    pattern:
      - Rising rejection drift → "Review the prompts that fired most
                                   in the rejected drafts."
      - DoW anomaly → "Investigate Tuesday-context inquiries — usually
                       the AI lands on those, but recent week didn't."
      - Stable but high edit rate → "Consider tightening the prompt
                                     for inquiry vs. client context."
  - confidence: 0.0-1.0. Higher when total > 50 + clear drift; lower
    when N near minimum or DoW anomaly is just past threshold.

CRITICAL RULES:
- Numbers in your output must come from the user prompt. The only
  numbers you may use are the recent total, approved/edited/rejected
  percentages (recent and prior), the drift pp, and any anomaly's
  rejected % / diff pp / n.
- Do not blame the coordinator OR the AI specifically. Frame as
  "drafts and coordinator are calibrating" or "the AI's draft fit
  has shifted".`

  const userPrompt = `COORDINATOR OVERRIDE PATTERN

Recent 4-week window (${classical.recent.total} drafts):
  - Approved: ${classical.recent.approved_pct}%
  - Edited:   ${classical.recent.edited_pct}%
  - Rejected: ${classical.recent.rejected_pct}%

${driftBlock}

Day-of-week rejection anomalies (>=20pp diff from mean, n>=5):
${dowBlock}

Diagnose the pattern + recommend a specific next step.`

  let result: CoordinatorDiagnostic | null = null
  // Cost-ceiling gate (T5-α.2). Drift-word fallback below covers paused.
  const gate = await gateForBrainCall(venueId)
  if (gate.ok) {
    try {
      const raw = await callAIJson<CoordinatorDiagnostic>({
        systemPrompt,
        userPrompt,
        maxTokens: 280,
        temperature: 0.3,
        venueId,
        taskType: 'coordinator_override_pattern',
        tier: 'sonnet',
        promptVersion: COORDINATOR_OVERRIDE_PROMPT_VERSION,
      })
      if (raw && typeof raw.reasoning === 'string') {
        result = {
          reasoning: raw.reasoning.trim() || 'Coordinator-AI draft mix shifted in the recent window.',
          recommendation: (raw.recommendation ?? '').trim() || 'Review last week\'s rejected drafts to identify the prompt or context pattern.',
          confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
        }
      }
    } catch (err) {
      // PII redaction — prompt carries draft-feedback aggregates; not
      // tier-1 PII shape but we keep the catch shape consistent across
      // T3. OPS-21.3.3.
      console.warn('[coordinator-override-pattern] LLM diagnostic failed:', redactError(err))
    }
  }

  if (!result) {
    const driftWord = classical.rejection_drift_pp !== null
      ? (classical.rejection_drift_pp > 0 ? 'rose' : 'fell')
      : 'changed'
    result = {
      reasoning: classical.rejection_drift_pp !== null
        ? `Rejection rate ${driftWord} ${Math.abs(classical.rejection_drift_pp)}pp vs the prior 4-week window.`
        : `${classical.dow_anomalies[0]?.day_label} rejection diverges from the week mean by ${classical.dow_anomalies[0]?.diff_from_mean_pp}pp.`,
      recommendation: 'Review the most-rejected drafts in /agent/drafts to identify the prompt or context pattern; consider tightening the prompt revision.',
      confidence: 0.4,
    }
  }

  const allowedNumbers: Array<number | string> = [
    classical.recent.total,
    classical.recent.approved_pct,
    classical.recent.edited_pct,
    classical.recent.rejected_pct,
    classical.prior?.total ?? 0,
    classical.prior?.approved_pct ?? 0,
    classical.prior?.edited_pct ?? 0,
    classical.prior?.rejected_pct ?? 0,
    classical.rejection_drift_pp ?? 0,
    Math.abs(classical.rejection_drift_pp ?? 0),
    ...classical.dow_anomalies.flatMap((a) => [
      a.rejected_pct, a.diff_from_mean_pp, Math.abs(a.diff_from_mean_pp), a.n,
    ]),
  ]

  const evidence: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: {
      ...classical,
      reasoning: result.reasoning,
      recommendation: result.recommendation,
    } as unknown as Record<string, unknown>,
    sampleSize: classical.recent.total,
    effectSize: Math.min(1, Math.max(
      Math.abs(classical.rejection_drift_pp ?? 0) / 30,
      classical.dow_anomalies.length > 0
        ? Math.abs(classical.dow_anomalies[0].diff_from_mean_pp) / 50
        : 0,
    )),
  }
  const conf = confidenceFor({ sampleSize: evidence.sampleSize, effectSize: evidence.effectSize })

  const narration: InsightNarration = {
    title: classical.dow_anomalies.length > 0
      ? `${classical.dow_anomalies[0].day_label} draft rejection diverges (${classical.dow_anomalies[0].rejected_pct}%)`
      : `Draft rejection drift: ${classical.rejection_drift_pp! >= 0 ? '+' : ''}${classical.rejection_drift_pp}pp`,
    body: result.reasoning,
    action: result.recommendation,
  }

  await persistInsight(supabase, {
    venueId,
    insightType: 'coordinator_override_pattern',
    contextId: VENUE_SCOPE_CONTEXT,
    category: 'agent_quality',
    surfaceLayer: 'pulse',
    classical: evidence,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: COORDINATOR_OVERRIDE_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: classical.recent.total + Math.abs(classical.rejection_drift_pp ?? 0),
    priority: Math.abs(classical.rejection_drift_pp ?? 0) >= 20 ? 'high'
      : Math.abs(classical.rejection_drift_pp ?? 0) >= 10 ? 'medium'
      : 'low',
    correlationId,
  })

  return {
    total_drafts: classical.recent.total,
    approved_pct: classical.recent.approved_pct,
    edited_pct: classical.recent.edited_pct,
    rejected_pct: classical.recent.rejected_pct,
    prior_approved_pct: classical.prior?.approved_pct ?? null,
    rejection_drift_pp: classical.rejection_drift_pp,
    dow_anomalies: classical.dow_anomalies.map((a) => ({
      day_label: a.day_label,
      rejected_pct: a.rejected_pct,
      diff_from_mean_pp: a.diff_from_mean_pp,
      n: a.n,
    })),
    reasoning: result.reasoning,
    recommendation: result.recommendation,
    confidence: conf.value,
    cached: false,
  }
}

// Pure helpers exported for unit tests.
export const __test__ = {
  actionMix,
  dowRejectionAnomalies,
  MIN_RECENT_FEEDBACK,
  MIN_PER_DOW_FEEDBACK,
  DOW_ANOMALY_PP_THRESHOLD,
  RECENT_WINDOW_DAYS,
  PRIOR_WINDOW_DAYS,
}
