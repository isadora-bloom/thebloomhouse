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
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

export const HEAT_NARRATION_PROMPT_VERSION = 'heat-narration.prompt.v1.0'

interface HeatEventForNarration {
  event_type: string
  points: number
  occurred_at: string | null
  metadata: Record<string, unknown>
}

interface ClassicalHeatPayload {
  weddingId: string
  heat_score: number
  temperature_tier: string
  top_events: Array<{
    event_type: string
    points: number
    occurred_at: string | null
  }>
  total_events: number
  newest_event_at: string | null
  oldest_event_at: string | null
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
    .select('id, heat_score, temperature_tier')
    .eq('id', weddingId)
    .eq('venue_id', venueId)
    .maybeSingle()
  if (!wedding) return null

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

  const payload: ClassicalHeatPayload = {
    weddingId,
    heat_score: (wedding.heat_score as number) ?? 0,
    temperature_tier: (wedding.temperature_tier as string) ?? 'cool',
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
  - body: 1-2 sentences. Ground every claim in the events listed below.
  - action: one specific next step the coordinator can take this week,
    matched to the heat tier (hot → push to contract; warm → tour follow-up;
    cool → re-engage). null if no clear action (informational only).

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
Total engagement events on file: ${payload.total_events}

Top contributing events (sorted by impact):
${eventsBlock}

Window: ${payload.oldest_event_at?.slice(0, 10) ?? '?'} → ${payload.newest_event_at?.slice(0, 10) ?? '?'}

Compose the JSON narration.`

  let narration: InsightNarration | null = null
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
    console.warn('[heat-narration] LLM call failed:', err instanceof Error ? err.message : err)
  }

  // Deterministic fallback when LLM unavailable. Numbers-guard tolerant
  // because every number used here comes from the classical payload.
  if (!narration) {
    const verb = payload.heat_score >= 80 ? 'Strong'
      : payload.heat_score >= 60 ? 'Warm'
      : payload.heat_score >= 40 ? 'Cool'
      : 'Quiet'
    const positiveEvents = payload.top_events.filter((e) => e.points > 0)
    const negativeEvents = payload.top_events.filter((e) => e.points < 0)
    const summary = positiveEvents.length > 0
      ? `${positiveEvents.slice(0, 3).map((e) => e.event_type).join(', ')} drove this score`
      : 'No strong positive signals on file'
    const concern = negativeEvents.length > 0
      ? `; offset by ${negativeEvents[0].event_type}`
      : ''
    narration = {
      title: `${verb} lead — ${payload.heat_score} (${payload.temperature_tier})`,
      body: `Heat score ${payload.heat_score} based on ${payload.total_events} engagement events. ${summary}${concern}.`,
      action: payload.heat_score >= 60
        ? 'Send a tour follow-up or proposal this week.'
        : 'Watch for re-engagement; queue a check-in if quiet for 14+ days.',
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
