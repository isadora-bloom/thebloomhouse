/**
 * T3-A: Heat-score narration insight (Playbook B-42 / INS-19.3.1).
 *
 * Pre-T3 the heat score was a number with a temperature_tier label
 * ("100 hot", "65 warm"). Coordinators looking at a hot lead had no
 * 1-2 sentence reasoning for WHY it's hot — they had to scroll the
 * Engagement Events list to figure it out.
 *
 * This module:
 *   1. Pulls the wedding's heat score + the top contributing events
 *      (classical: events with the highest |points|, recency-weighted)
 *   2. Asks Claude (Sonnet) to compose a 1-2 sentence reasoning
 *      grounded in those events. The prompt forbids the LLM from
 *      generating numbers — only the events' own points + the
 *      composite score are referenced.
 *   3. Runs numbers-guard on the output.
 *   4. Persists via the shared insight infra (cache key keyed on
 *      score + top events; same inputs → no re-narration cost).
 *
 * The narration becomes a hover-expandable badge on /agent/leads,
 * /agent/pipeline, and the lead detail (consumer wiring is the
 * follow-up commit; this commit ships the generator).
 *
 * Always uses {aiName} not 'Sage' (per INV-4.4-A); resolved per-venue.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAI, CLAUDE_MODEL } from '@/lib/ai/client'
import { gateForBrainCall } from '@/lib/services/cost-ceiling'
import { redactError } from '@/lib/observability/redact'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

// T5-followup-AA (2026-05-02): bumped to v1.1 — trajectory bucket
// added to the prompt so the LLM grounds its prose in rising / falling
// / plateau / volatile direction, not just the static score.
export const HEAT_NARRATION_PROMPT_VERSION = 'heat-narration.prompt.v1.1'

interface HeatEventForNarration {
  event_type: string
  points: number
  occurred_at: string | null
  metadata: Record<string, unknown>
}

/** Trajectory bucket of the wedding's heat over the last ~14 days.
 *  Same heat_score with different trajectories (e.g. "rising fast"
 *  vs "recovering from a stall") deserves different prose. T5-followup-AA.
 *  Buckets:
 *    rising   — monotonic up across the last 7 days (or near-monotonic with a single
 *               down-tick smaller than half the avg up-step)
 *    falling  — monotonic down across the last 7 days (mirror of rising)
 *    plateau  — stddev of last 14 days < PLATEAU_STDDEV
 *    volatile — anything else
 *  unknown    — fewer than 2 history rows so trajectory cannot be inferred
 */
export type HeatTrajectory = 'rising' | 'falling' | 'plateau' | 'volatile' | 'unknown'

interface ClassicalHeatPayload {
  weddingId: string
  heat_score: number
  temperature_tier: string
  /** ISO yyyy-mm-dd. Captured here so the cache_key invalidates when
   *  a coordinator corrects inquiry_date — INV-2.5 / T5-delta.1. The
   *  trigger 158 nulls last_classical_signature, but having the day
   *  in the cache_key is belt-and-braces for manual refresh paths
   *  that bypass the signature compare. */
  inquiry_date_day: string | null
  /** T5-followup-AA. Same score, different trajectory → different
   *  narration. ONE more cache-miss vector by design — the platform
   *  underreports volatility today. 4 buckets is enough; we don't
   *  over-bucket. */
  trajectory: HeatTrajectory
  top_events: Array<{
    event_type: string
    points: number
    occurred_at: string | null
  }>
  total_events: number
  newest_event_at: string | null
  oldest_event_at: string | null
}

const TRAJECTORY_LOOKBACK_DAYS = 14
const PLATEAU_STDDEV = 5

/**
 * Classify the wedding's heat trajectory from its recent score history.
 * Pulls up to TRAJECTORY_LOOKBACK_DAYS of `lead_score_history` rows and
 * walks them oldest-first.
 *
 * Rules (in order):
 *   - <2 rows: 'unknown' (no slope to talk about).
 *   - stddev of all observed scores < PLATEAU_STDDEV: 'plateau'.
 *   - last-7-day window monotonic up (allow ONE downtick smaller than
 *     half the avg up-step): 'rising'.
 *   - last-7-day window monotonic down (mirror): 'falling'.
 *   - else: 'volatile'.
 *
 * Pure read; no writes.
 */
export async function classifyHeatTrajectory(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  lookbackDays: number = TRAJECTORY_LOOKBACK_DAYS,
): Promise<HeatTrajectory> {
  const since = new Date(Date.now() - lookbackDays * 86400e3).toISOString()
  const { data: rows } = await supabase
    .from('lead_score_history')
    .select('score, calculated_at')
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .gte('calculated_at', since)
    .order('calculated_at', { ascending: true })
    .limit(200)

  const scores = (rows ?? [])
    .map((r) => Number((r as { score: number | null }).score ?? NaN))
    .filter((n) => Number.isFinite(n))
  if (scores.length < 2) return 'unknown'

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  const variance =
    scores.reduce((acc, s) => acc + (s - mean) * (s - mean), 0) / scores.length
  const stddev = Math.sqrt(variance)
  if (stddev < PLATEAU_STDDEV) return 'plateau'

  // Last-7-day slice for monotonicity tests.
  const sevenDayCutoff = Date.now() - 7 * 86400e3
  const recent = (rows ?? []).filter((r) => {
    const t = new Date((r as { calculated_at: string | null }).calculated_at ?? 0).getTime()
    return Number.isFinite(t) && t >= sevenDayCutoff
  }).map((r) => Number((r as { score: number | null }).score ?? NaN))
   .filter((n) => Number.isFinite(n))
  if (recent.length >= 2) {
    const ups: number[] = []
    const downs: number[] = []
    for (let i = 1; i < recent.length; i++) {
      const d = recent[i] - recent[i - 1]
      if (d > 0) ups.push(d)
      else if (d < 0) downs.push(-d)
    }
    const avgUp = ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : 0
    const avgDown = downs.length ? downs.reduce((a, b) => a + b, 0) / downs.length : 0
    // 'rising': mostly ups; at most one downtick AND it must be small
    // (< half the avg up-step) so a one-off jitter doesn't disqualify.
    if (ups.length >= 1 && (downs.length === 0 || (downs.length === 1 && downs[0] < avgUp * 0.5))) {
      return 'rising'
    }
    if (downs.length >= 1 && (ups.length === 0 || (ups.length === 1 && ups[0] < avgDown * 0.5))) {
      return 'falling'
    }
  }
  return 'volatile'
}

/**
 * Pull the inputs for the narration. Pure read; runs at the candidate
 * narration site. Top-7 events by absolute points value, ordered by
 * occurred_at desc within each tier so the narrator sees "recent
 * stuff first" — matters because heat decays.
 */
async function loadClassicalHeatEvidence(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
): Promise<{ payload: ClassicalHeatPayload; allowedNumbers: Array<number | string> } | null> {
  const { data: wedding } = await supabase
    .from('weddings')
    .select('id, heat_score, temperature_tier, inquiry_date')
    .eq('id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!wedding) return null

  const inquiryDateDay = wedding.inquiry_date
    ? new Date(wedding.inquiry_date as string).toISOString().slice(0, 10)
    : null

  // Trajectory lookup runs in parallel with the events query below.
  const trajectoryPromise = classifyHeatTrajectory(supabase, venueId, weddingId)

  const { data: events, count: totalEvents } = await supabase
    .from('engagement_events')
    .select('event_type, points, occurred_at, metadata, created_at', { count: 'exact' })
    .eq('venue_id', venueId)
    .eq('wedding_id', weddingId)
    .order('occurred_at', { ascending: false })
    .limit(40)

  const list = ((events ?? []) as HeatEventForNarration[])
  if (list.length === 0) return null

  // Top-7 by absolute points (most-impactful events shape the
  // narrative most).
  const topEvents = [...list]
    .sort((a, b) => Math.abs(b.points ?? 0) - Math.abs(a.points ?? 0))
    .slice(0, 7)
    .map((e) => ({
      event_type: e.event_type,
      points: e.points ?? 0,
      occurred_at: e.occurred_at,
    }))

  const newest = list[0]?.occurred_at ?? null
  const oldest = list[list.length - 1]?.occurred_at ?? null
  const trajectory = await trajectoryPromise

  const payload: ClassicalHeatPayload = {
    weddingId,
    heat_score: (wedding.heat_score as number) ?? 0,
    temperature_tier: (wedding.temperature_tier as string) ?? 'cool',
    inquiry_date_day: inquiryDateDay,
    trajectory,
    top_events: topEvents,
    total_events: totalEvents ?? list.length,
    newest_event_at: newest,
    oldest_event_at: oldest,
  }

  // Numbers the narration is allowed to reference: the score, every
  // event's points (signed and absolute), and the total event count.
  // The narrator is forbidden from inventing percentages, ratios, or
  // ranks not in this list.
  const allowedNumbers: Array<number | string> = [
    payload.heat_score,
    Math.abs(payload.heat_score),
    payload.total_events,
    ...topEvents.flatMap((e) => [e.points, Math.abs(e.points)]),
  ]
  return { payload, allowedNumbers }
}

async function loadAiName(supabase: SupabaseClient, venueId: string): Promise<string> {
  const { data } = await supabase
    .from('venue_ai_config')
    .select('ai_name')
    .eq('venue_id', venueId)
    .maybeSingle()
  const name = (data?.ai_name as string | undefined)?.trim()
  return name || 'your assistant'
}

/**
 * Generate (or fetch from cache) the heat-score narration for a
 * wedding. Always returns a row even when narration fails — falls
 * back to a deterministic template so coordinators always see *some*
 * reasoning.
 */
export async function generateHeatNarration(
  supabase: SupabaseClient,
  venueId: string,
  weddingId: string,
  /** Set true to bypass cache (e.g. coordinator manual regenerate). */
  force: boolean = false,
  /** T5-eta.3 forensic-chain correlation id; threads through to
   *  persistInsight so the row carries the same id as the api_costs
   *  + downstream side-effects from this generator run. */
  correlationId: string | null = null,
): Promise<{
  title: string
  body: string
  action: string | null
  confidence: number
  cached: boolean
} | null> {
  const evidence = await loadClassicalHeatEvidence(supabase, venueId, weddingId)
  if (!evidence) return null
  const { payload, allowedNumbers } = evidence

  const cacheKey = buildCacheKey({
    score: payload.heat_score,
    tier: payload.temperature_tier,
    // T5-delta.1 (2026-05-02). inquiry_date in the fingerprint so a
    // coordinator correction (back-dating a misread inquiry, fixing a
    // bad import) invalidates the cached narration even when the
    // trigger-driven signature null somehow misses (e.g. cache_key was
    // never reached during write). Belt-and-braces with migration 158.
    inquiryDateDay: payload.inquiry_date_day ?? '',
    // T5-followup-AA (2026-05-02). Same score, different trajectory →
    // different narration (e.g. "rising fast" vs "recovering from a
    // stall"). The trajectory bucket adds ONE more cache-miss vector
    // by design. 4 buckets (+ 'unknown' for cold-start) is enough; we
    // don't over-bucket. Without this, a wedding climbing 40→55→70 and
    // a wedding crashing 100→85→70 collapse onto the same cached prose.
    trajectory: payload.trajectory,
    // Include occurred_at-day in the fingerprint so two events of the
    // same type+points but different days don't collapse into a stale
    // cache hit. Pre-fix the cache key dropped occurred_at, which made
    // a fresh tour_completed (re-fired after a re-engagement) look
    // identical to a year-old tour_completed. T3 review P1 #18.
    topEvents: payload.top_events.map((e) =>
      `${e.event_type}@${e.points}@${(e.occurred_at ?? '').slice(0, 10)}`,
    ),
    totalEvents: payload.total_events,
  })

  if (!force) {
    const cached = await lookupCachedInsight(
      supabase, venueId, 'heat_narration', weddingId, cacheKey,
    )
    if (cached) {
      return {
        title: cached.title,
        body: cached.body,
        action: cached.action,
        confidence: cached.confidence,
        cached: true,
      }
    }
  }

  const aiName = await loadAiName(supabase, venueId)
  const eventsBlock = payload.top_events
    .map((e) => `  - ${e.event_type} (${e.points >= 0 ? '+' : ''}${e.points} pts)${e.occurred_at ? ' on ' + e.occurred_at.slice(0, 10) : ''}`)
    .join('\n')

  const systemPrompt = `You are ${aiName}, a wedding-venue concierge. You're explaining to a venue
coordinator WHY a particular lead's heat score is what it is. Output JSON with:
  - title: a short headline (max ~60 chars). Refer to the lead via the
    score + tier (e.g. "Strong lead — sustained engagement + tour completion").
  - body: 1-2 sentences. Ground every claim in the events listed below
    AND in the heat trajectory (see "Trajectory" in user prompt). When the
    trajectory is rising / falling / plateau / volatile, that direction MUST
    be referenced — same score with different trajectory should read very
    differently (e.g. "climbing fast" vs "recovering from a stall" vs "stable
    at warm" vs "swinging week-to-week").
  - action: one specific next step the coordinator can take this week,
    matched to the heat tier AND trajectory (hot+rising → push to contract;
    hot+falling → urgent re-engagement; warm+plateau → tour follow-up;
    warm+volatile → stabilise with a clarifying call; cool+rising → nurture;
    cool+falling → re-engage; unknown → tier-default action). null if no
    clear action (informational only).

CRITICAL RULES:
- Never invent numbers. The ONLY numbers you may reference are the heat
  score, the events' point values, and the total event count — all listed
  in the user prompt. No percentages, ratios, or ranks unless they are
  exact matches to the listed numbers.
- Never reference other couples or venues; only this lead.
- Never claim to know what the couple is "thinking" or "feeling" — narrate
  observed signals, not interpretations.
- Use the venue's voice but stay neutral / factual.`

  const userPrompt = `LEAD HEAT NARRATION

Composite score: ${payload.heat_score} (${payload.temperature_tier})
Trajectory (last ~14 days): ${payload.trajectory}
Total engagement events on file: ${payload.total_events}

Top contributing events (sorted by impact):
${eventsBlock}

Window: ${payload.oldest_event_at?.slice(0, 10) ?? '?'} → ${payload.newest_event_at?.slice(0, 10) ?? '?'}

Compose the JSON narration. Reference the trajectory direction in the body
so a coordinator scanning a list of leads can tell at a glance which way
this lead is moving.`

  let narration: InsightNarration | null = null
  // Cost-ceiling gate (T5-α.2). Per OPS-21.4.3, when a venue's daily
  // ceiling is hit autonomous behavior pauses — including proactive
  // insights. The deterministic fallback below still runs so the
  // coordinator sees *some* reasoning even when paused.
  const gate = await gateForBrainCall(venueId)
  if (gate.ok) {
    try {
      const result = await callAI({
        systemPrompt,
        userPrompt,
        maxTokens: 280,
        temperature: 0.4,
        venueId,
        taskType: 'heat_narration',
        tier: 'sonnet',
        promptVersion: HEAT_NARRATION_PROMPT_VERSION,
      })
      const parsed = JSON.parse(
        result.text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim(),
      ) as Partial<InsightNarration>
      if (parsed.title && parsed.body) {
        narration = {
          title: parsed.title,
          body: parsed.body,
          action: parsed.action ?? null,
        }
      }
    } catch (err) {
      // redactError strips PII (couple email, phone, long quoted
      // strings) before stdout; Anthropic 4xx echoes prompt content
      // into err.message which contains tier-1 couple PII. OPS-21.3.3.
      console.warn('[heat-narration] LLM call failed:', redactError(err))
    }
  }

  // Deterministic fallback when LLM unavailable. Numbers-guard tolerant
  // because every number used here comes from the classical payload.
  // T5-followup-AA: trajectory-aware so the fallback prose reflects
  // direction, matching the bucketing we feed into the cache_key.
  if (!narration) {
    const verb = payload.heat_score >= 80 ? 'Strong'
      : payload.heat_score >= 60 ? 'Warm'
      : payload.heat_score >= 40 ? 'Cool'
      : 'Quiet'
    const trajPhrase: Record<HeatTrajectory, string> = {
      rising: 'climbing',
      falling: 'cooling',
      plateau: 'holding steady',
      volatile: 'swinging week-to-week',
      unknown: 'newly tracked',
    }
    const positiveEvents = payload.top_events.filter((e) => e.points > 0)
    const negativeEvents = payload.top_events.filter((e) => e.points < 0)
    const summary = positiveEvents.length > 0
      ? `${positiveEvents.slice(0, 3).map((e) => e.event_type).join(', ')} drove this score`
      : 'No strong positive signals on file'
    const concern = negativeEvents.length > 0
      ? `; offset by ${negativeEvents[0].event_type}`
      : ''
    // Action picks based on (tier × trajectory) so the same warm-tier
    // lead reads as "stabilise with a clarifying call" when volatile vs
    // "send a tour follow-up" when steady.
    let action: string
    if (payload.trajectory === 'falling') {
      action = payload.heat_score >= 60
        ? 'Heat is dropping — send a re-engagement note this week.'
        : 'Queue a re-engagement nudge before the lead goes cold.'
    } else if (payload.trajectory === 'volatile') {
      action = 'Stabilise with a clarifying call to confirm interest.'
    } else if (payload.trajectory === 'rising') {
      action = payload.heat_score >= 60
        ? 'Momentum is building — push toward proposal or contract.'
        : 'Nurture the upward trend with a personal follow-up.'
    } else {
      action = payload.heat_score >= 60
        ? 'Send a tour follow-up or proposal this week.'
        : 'Watch for re-engagement; queue a check-in if quiet for 14+ days.'
    }
    narration = {
      title: `${verb} lead — ${payload.heat_score} (${payload.temperature_tier}, ${trajPhrase[payload.trajectory]})`,
      body: `Heat score ${payload.heat_score} based on ${payload.total_events} engagement events; ${trajPhrase[payload.trajectory]} over the last ~14 days. ${summary}${concern}.`,
      action,
    }
  }

  const classical: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: payload as unknown as Record<string, unknown>,
    sampleSize: payload.total_events,
    effectSize: Math.min(1, Math.abs(payload.heat_score) / 100),
  }
  const conf = confidenceFor({
    sampleSize: payload.total_events,
    effectSize: classical.effectSize,
  })

  const result = await persistInsight(supabase, {
    venueId,
    insightType: 'heat_narration',
    contextId: weddingId,
    category: 'lead_conversion',
    surfaceLayer: 'inline',
    classical,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: HEAT_NARRATION_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: payload.heat_score,
    priority: payload.heat_score >= 80 ? 'high'
      : payload.heat_score >= 60 ? 'medium'
      : 'low',
    correlationId,
  })

  if (!result.ok) {
    if (result.numbersGuardViolations) {
      console.warn(
        '[heat-narration] numbers-guard rejected narration:',
        result.numbersGuardViolations.map((v) => v.token).join(', '),
      )
    }
    // Degrade gracefully — return the narration anyway (in-memory),
    // just don't cache. Next run will re-attempt; eventually a clean
    // narration will land.
    return { ...narration, confidence: conf.value, cached: false }
  }

  return { ...narration, confidence: conf.value, cached: false }
}
