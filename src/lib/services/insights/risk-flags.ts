/**
 * T3-H: Risk-flag insight (Playbook INS-19.3.5).
 *
 * Detects per-wedding risk indicators via rule-based classical pass +
 * LLM sentiment scan, combined into a composite risk score with
 * expandable evidence.
 *
 * Classical risk rules (deterministic, no LLM):
 *   - missing_contract:       wedding.status='booked' AND no contract_signed event > 30d ago
 *   - missing_timeline:       wedding within 90 days AND timeline rows count = 0
 *   - missing_vendors:        wedding within 60 days AND <3 booked_vendors rows
 *   - overdue_response:       last inbound > 7d ago AND no outbound since
 *   - heat_dropping:          score declined >25 points in 14 days
 *   - friction_present:       weddings.friction_tags non-empty
 *   - silent_after_tour:      tour_completed > 7d AND no inbound since
 *
 * LLM sentiment overlay scans the last 3 inbound messages for negative
 * or hesitant tone — adds a nuanced flag the rule set can't catch.
 *
 * The composite combines flag count + severity weights into a 0..100
 * risk_score; LLM narrates the top 2-3 flags into a 1-sentence
 * coordinator-facing summary.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

export const RISK_FLAGS_PROMPT_VERSION = 'risk-flags.prompt.v1.0'

/**
 * Strip likely PII (emails / phone numbers) from a free-text friction
 * tag before it gets persisted into intelligence_insights.evidence /
 * data_points. Coordinators occasionally type natural-language tags
 * that accidentally include couple email or phone; without this
 * sanitiser the value lands in the insight row and surfaces in
 * /intel UIs. Conservative replacements with a tag marker so the
 * insight reads as "Friction tags: payment_late, [redacted]".
 */
export function sanitizeFrictionTag(tag: string): string {
  if (!tag) return tag
  // Trim and clamp length first.
  const trimmed = String(tag).slice(0, 80).trim()
  if (!trimmed) return trimmed
  let cleaned = trimmed
  // Email
  cleaned = cleaned.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted-email]')
  // Phone (US-shaped — 10 digits with optional country code +
  // optional separators). Lookbehind/lookahead anchors prevent the
  // optional leading separator from chewing the preceding word's
  // trailing space (which would garble the surrounding sentence).
  cleaned = cleaned.replace(
    /(?<![\d])(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}(?![\d])/g,
    '[redacted-phone]',
  )
  return cleaned
}

export type RiskFlagCode =
  | 'missing_contract'
  | 'missing_timeline'
  | 'missing_vendors'
  | 'overdue_response'
  | 'heat_dropping'
  | 'friction_present'
  | 'silent_after_tour'
  | 'sentiment_negative'

export interface RiskFlag {
  code: RiskFlagCode
  /** 1-3, where 3 is highest. Drives the composite score. */
  severity: 1 | 2 | 3
  /** Plain-text evidence the coordinator sees in the expanded view. */
  evidence: string
}

const FLAG_LABEL: Record<RiskFlagCode, string> = {
  missing_contract: 'Missing contract',
  missing_timeline: 'Missing timeline',
  missing_vendors: 'Few vendors booked',
  overdue_response: 'Overdue response',
  heat_dropping: 'Heat dropping',
  friction_present: 'Friction signals',
  silent_after_tour: 'Silent after tour',
  sentiment_negative: 'Negative sentiment',
}

interface ClassicalRiskPayload {
  weddingId: string
  status: string
  wedding_date: string | null
  flags: RiskFlag[]
  /** 0..100 composite. Severity-weighted sum, capped at 100. */
  risk_score: number
}

const DAY_MS = 86_400_000

async function classicalRiskPass(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<ClassicalRiskPayload | null> {
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, status, wedding_date, friction_tags, heat_score, lost_at')
    .eq('id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!wedding) return null

  const status = (wedding.status as string) ?? 'inquiry'
  // Skip terminal weddings — risk doesn't apply post-completion.
  if (status === 'lost' || status === 'cancelled' || status === 'completed') return null

  const weddingDate = wedding.wedding_date as string | null
  const weddingMs = weddingDate ? Date.parse(weddingDate) : NaN
  const daysToWedding = Number.isFinite(weddingMs)
    ? Math.round((weddingMs - Date.now()) / DAY_MS)
    : null

  const flags: RiskFlag[] = []

  // Rule: missing_contract — booked but no contract_signed event
  // logged > 30 days ago.
  if (status === 'booked') {
    const { data: contractEvents } = await supabase
      .from('engagement_events')
      .select('occurred_at')
      .eq('wedding_id', weddingId)
      .in('event_type', ['contract_signed', 'honeybook_contract_signed'])
      .order('occurred_at', { ascending: false })
      .limit(1)
    const latestContract = (contractEvents ?? [])[0]
    if (!latestContract) {
      flags.push({
        code: 'missing_contract',
        severity: 3,
        evidence: 'Wedding is booked but no contract_signed event on file.',
      })
    } else if (latestContract.occurred_at) {
      const ageDays = (Date.now() - Date.parse(latestContract.occurred_at)) / DAY_MS
      if (ageDays > 30 && daysToWedding !== null && daysToWedding < 60) {
        flags.push({
          code: 'missing_contract',
          severity: 2,
          evidence: `Contract signed but ${Math.round(ageDays)} days ago — verify still binding.`,
        })
      }
    }
  }

  // Rule: missing_timeline — within 90 days of wedding, no timeline.
  if (daysToWedding !== null && daysToWedding < 90 && daysToWedding > 0) {
    const { count: timelineCount } = await supabase
      .from('timeline')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', weddingId)
    if ((timelineCount ?? 0) === 0) {
      flags.push({
        code: 'missing_timeline',
        severity: 2,
        evidence: `${daysToWedding} days to wedding and no timeline drafted yet.`,
      })
    }
  }

  // Rule: missing_vendors — within 60 days, fewer than 3 booked vendors.
  if (daysToWedding !== null && daysToWedding < 60 && daysToWedding > 0) {
    const { count: vendorCount } = await supabase
      .from('booked_vendors')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', weddingId)
      .eq('is_booked', true)
    const cnt = vendorCount ?? 0
    if (cnt < 3) {
      flags.push({
        code: 'missing_vendors',
        severity: cnt === 0 ? 3 : 2,
        evidence: `Only ${cnt} vendor${cnt === 1 ? '' : 's'} booked with ${daysToWedding} days to go.`,
      })
    }
  }

  // Rule: overdue_response — last inbound > 7 days, no outbound since.
  const { data: lastInbound } = await supabase
    .from('interactions')
    .select('timestamp, direction')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
    .order('timestamp', { ascending: false })
    .limit(1)
  const last = (lastInbound ?? [])[0]
  if (last && last.direction === 'inbound' && last.timestamp) {
    const ageDays = (Date.now() - Date.parse(last.timestamp)) / DAY_MS
    if (ageDays > 7 && status !== 'booked') {
      flags.push({
        code: 'overdue_response',
        severity: ageDays > 14 ? 3 : 2,
        evidence: `Last inbound was ${Math.round(ageDays)} days ago and no reply yet.`,
      })
    }
  }

  // Rule: heat_dropping — score down >25 points in 14 days.
  const fourteenDaysAgo = new Date(Date.now() - 14 * DAY_MS).toISOString()
  const { data: scoreHistory } = await supabase
    .from('lead_score_history')
    .select('score, calculated_at')
    .eq('wedding_id', weddingId)
    .gte('calculated_at', fourteenDaysAgo)
    .order('calculated_at', { ascending: true })
  if (scoreHistory && scoreHistory.length >= 2) {
    const first = scoreHistory[0].score as number
    const last = scoreHistory[scoreHistory.length - 1].score as number
    if (first - last > 25) {
      flags.push({
        code: 'heat_dropping',
        severity: 2,
        evidence: `Heat dropped from ${first} to ${last} over the last 14 days.`,
      })
    }
  }

  // Rule: friction_present — coordinator-tagged friction signals.
  // Sanitise tag content before persisting into intelligence_insights:
  // friction_tags is a free-text array, and nothing prevents a
  // coordinator from accidentally typing PII ("jane@example.com
  // complained") that would otherwise be persisted verbatim into the
  // insight row's evidence + data_points jsonb. T3 review P1 #8.
  const frictionTagsRaw = Array.isArray(wedding.friction_tags) ? wedding.friction_tags as string[] : []
  const frictionTags = frictionTagsRaw.map(sanitizeFrictionTag)
  if (frictionTags.length > 0) {
    flags.push({
      code: 'friction_present',
      severity: frictionTags.includes('honeybook_refund_received') ? 3 : 2,
      evidence: `Friction tags: ${frictionTags.slice(0, 3).join(', ')}.`,
    })
  }

  // Rule: silent_after_tour — tour_completed > 7d ago, no inbound since.
  const { data: lastTour } = await supabase
    .from('engagement_events')
    .select('occurred_at')
    .eq('wedding_id', weddingId)
    .eq('event_type', 'tour_completed')
    .order('occurred_at', { ascending: false })
    .limit(1)
  const tourEvt = (lastTour ?? [])[0]
  if (tourEvt && tourEvt.occurred_at) {
    const tourMs = Date.parse(tourEvt.occurred_at)
    if (Number.isFinite(tourMs) && Date.now() - tourMs > 7 * DAY_MS) {
      const tourIso = new Date(tourMs).toISOString()
      const { data: anyInboundSince } = await supabase
        .from('interactions')
        .select('id')
        .eq('wedding_id', weddingId)
        .eq('direction', 'inbound')
        .gte('timestamp', tourIso)
        .limit(1)
      if (!anyInboundSince || anyInboundSince.length === 0) {
        const ageDays = Math.round((Date.now() - tourMs) / DAY_MS)
        flags.push({
          code: 'silent_after_tour',
          severity: ageDays > 14 ? 3 : 2,
          evidence: `Tour completed ${ageDays} days ago — no inbound since.`,
        })
      }
    }
  }

  // Composite score: severity-weighted sum, capped at 100.
  const rawScore = flags.reduce((sum, f) => sum + f.severity * 12, 0)
  const riskScore = Math.min(100, rawScore)

  return {
    weddingId,
    status,
    wedding_date: weddingDate,
    flags,
    risk_score: riskScore,
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

interface SentimentResult {
  negative: boolean
  evidence: string
}

async function sentimentScan(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  aiName: string,
): Promise<SentimentResult | null> {
  const { data: recentInbound } = await supabase
    .from('interactions')
    .select('subject, body_preview, full_body')
    .eq('wedding_id', weddingId)
    .eq('venue_id', venueId)
    .eq('direction', 'inbound')
    .order('timestamp', { ascending: false })
    .limit(3)
  const list = (recentInbound ?? []) as Array<{ subject: string | null; body_preview: string | null; full_body: string | null }>
  if (list.length === 0) return null

  const excerpts = list
    .map((i, idx) => `[${idx + 1}] ${(i.subject ?? '').slice(0, 100)}\n${(i.body_preview ?? i.full_body ?? '').slice(0, 280)}`)
    .join('\n\n')

  const systemPrompt = `You are ${aiName}, classifying whether a couple's recent inbound messages
contain NEGATIVE OR HESITANT sentiment that signals potential lead-loss risk. Examples:
  - frustration with response time, venue policy, or coordination
  - hesitation expressed about budget, capacity, or fit
  - signals of comparison-shopping that lean unfavourable to this venue
  - unanswered questions accumulating
Output JSON: { negative: boolean, evidence: "1 short sentence describing the signal" }
The evidence should reference the SHAPE of the signal, not invent quotes. If sentiment is
neutral or positive, output { negative: false, evidence: "" }.
Don't hedge — when uncertain, output negative: false.`

  const userPrompt = `Last 3 inbound messages:\n\n${excerpts}\n\nClassify sentiment.`

  try {
    const result = await callAIJson<SentimentResult>({
      systemPrompt,
      userPrompt,
      maxTokens: 180,
      temperature: 0.2,
      venueId,
      taskType: 'risk_sentiment_scan',
      tier: 'haiku',
      promptVersion: RISK_FLAGS_PROMPT_VERSION,
    })
    return result
  } catch (err) {
    // PII redaction — prompt carries recent inbound subjects + bodies.
    // OPS-21.3.3.
    console.warn('[risk-flags] sentiment scan failed:', redactError(err))
    return null
  }
}

export async function generateRiskFlags(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  force: boolean = false,
): Promise<{
  risk_score: number
  flags: RiskFlag[]
  flag_labels: string[]
  summary: string
  action: string | null
  confidence: number
  cached: boolean
} | null> {
  const classical = await classicalRiskPass(supabase, venueId, weddingId)
  if (!classical) return null

  const aiName = await loadAiName(supabase, venueId)

  // Cost-ceiling gate (T5-α.2). One gate check covers both the
  // sentiment overlay AND the narration LLM call below — both are
  // tier-1 brain spends. When paused, the rule-based classical flags
  // still surface (no LLM dependency); just no LLM-driven sentiment
  // overlay or narration polish.
  const gate = await gateForBrainCall(venueId)

  // Sentiment overlay (LLM). Adds a flag if negative. Skipped when
  // ceiling-paused so we don't spend Haiku on a paused venue.
  const sentiment = gate.ok
    ? await sentimentScan(supabase, venueId, weddingId, aiName)
    : null
  if (sentiment?.negative) {
    classical.flags.push({
      code: 'sentiment_negative',
      severity: 2,
      evidence: sentiment.evidence,
    })
    classical.risk_score = Math.min(100, classical.risk_score + 24)
  }

  const cacheKey = buildCacheKey({
    weddingId,
    status: classical.status,
    flags: classical.flags.map((f) => `${f.code}:${f.severity}`).sort(),
    risk_score: classical.risk_score,
  })

  if (!force) {
    const cached = await lookupCachedInsight(supabase, venueId, 'risk_flag', weddingId, cacheKey)
    if (cached) {
      const dp = cached.data_points as { flags?: RiskFlag[]; risk_score?: number }
      return {
        risk_score: dp.risk_score ?? classical.risk_score,
        flags: dp.flags ?? classical.flags,
        flag_labels: (dp.flags ?? classical.flags).map((f) => FLAG_LABEL[f.code] ?? f.code),
        summary: cached.body,
        action: cached.action,
        confidence: cached.confidence,
        cached: true,
      }
    }
  }

  // Compose summary + action via LLM. Numbers-guard restricts to the
  // risk_score and per-flag counts.
  const flagsBlock = classical.flags
    .map((f) => `  - [sev ${f.severity}] ${FLAG_LABEL[f.code] ?? f.code}: ${f.evidence}`)
    .join('\n')

  const allowedNumbers: Array<number | string> = [
    classical.risk_score,
    classical.flags.length,
    ...classical.flags.map((f) => f.severity),
  ]

  const systemPrompt = `You are ${aiName}, summarising a couple's risk flags for a venue
coordinator. Output JSON:
  - title: short headline (~60 chars)
  - body: 1 sentence summarising the top 2-3 flags
  - action: one specific next step the coordinator can take this week.
            null if every flag is below severity 2.

CRITICAL RULES:
- Don't invent numbers. The only numbers you may use: the risk score
  (${classical.risk_score}), the flag count (${classical.flags.length}),
  and the per-flag severities listed below.
- Don't quote the couple's messages directly; reference flag shapes.
- Prioritise the highest-severity flags in the body.`

  const userPrompt = `RISK FLAG SUMMARY

Risk score: ${classical.risk_score} / 100
Flag count: ${classical.flags.length}

Flags:
${flagsBlock || '  (no flags — coordinator-facing reassurance)'}

Compose the JSON.`

  let narration: InsightNarration = {
    title: classical.flags.length === 0
      ? 'No risk flags'
      : `${classical.flags.length} risk flag${classical.flags.length === 1 ? '' : 's'} (score ${classical.risk_score}/100)`,
    body: classical.flags.length === 0
      ? 'No active risk flags on this lead.'
      : `Top concerns: ${classical.flags.slice(0, 3).map((f) => FLAG_LABEL[f.code] ?? f.code).join(', ')}.`,
    action: classical.flags.length > 0 && classical.flags.some((f) => f.severity >= 2)
      ? 'Review the lead detail for evidence and decide next step.'
      : null,
  }

  // Same cost-ceiling gate from above — skip narration polish when
  // paused; the deterministic narration assembled above (FLAG_LABEL +
  // count) is still surfaced.
  if (classical.flags.length > 0 && gate.ok) {
    try {
      const result = await callAIJson<InsightNarration>({
        systemPrompt,
        userPrompt,
        maxTokens: 240,
        temperature: 0.3,
        venueId,
        taskType: 'risk_flags',
        tier: 'sonnet',
        promptVersion: RISK_FLAGS_PROMPT_VERSION,
      })
      if (result?.title && result?.body) {
        narration = {
          title: result.title.slice(0, 80),
          body: result.body,
          action: result.action ?? null,
        }
      }
    } catch (err) {
      // PII redaction — prompt carries flag evidence which can include
      // friction-tag text + interaction snippets. OPS-21.3.3.
      console.warn('[risk-flags] narration LLM failed:', redactError(err))
    }
  }

  const evidence: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: {
      flags: classical.flags,
      risk_score: classical.risk_score,
      status: classical.status,
      wedding_date: classical.wedding_date,
    },
    sampleSize: classical.flags.length,
    effectSize: Math.min(1, classical.risk_score / 100),
  }
  const conf = confidenceFor({ sampleSize: classical.flags.length, effectSize: evidence.effectSize })

  await persistInsight(supabase, {
    venueId,
    insightType: 'risk_flag',
    contextId: weddingId,
    category: 'lead_conversion',
    surfaceLayer: classical.risk_score >= 50 ? 'pulse' : 'inline',
    classical: evidence,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: RISK_FLAGS_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: classical.risk_score,
    priority: classical.risk_score >= 70 ? 'high'
      : classical.risk_score >= 40 ? 'medium'
      : 'low',
  })

  return {
    risk_score: classical.risk_score,
    flags: classical.flags,
    flag_labels: classical.flags.map((f) => FLAG_LABEL[f.code] ?? f.code),
    summary: narration.body,
    action: narration.action,
    confidence: conf.value,
    cached: false,
  }
}
