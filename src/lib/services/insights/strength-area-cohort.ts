/**
 * T3-I (b): Strength-area cohort identification (Playbook INS-19.6.2).
 *
 * Per-guest-count-band conversion-rate breakdown for the venue's own
 * track record. Flags the band the venue is STRONGEST at (highest
 * conversion, sufficient N) and the band it's WEAKEST at — driving
 * the strategic question "which segment should I lean into?"
 *
 * Bandaid traps avoided:
 *
 *   - Tiny bands (only 1-2 weddings in 200+) → require >=5 resolved
 *     weddings per band before including in comparison. Bands below
 *     threshold are reported as "insufficient data" rather than
 *     ranked.
 *
 *   - Selection bias from booked-only counts → conversion uses
 *     terminal-status weddings (booked + completed + lost). Both
 *     outcomes counted in denominator.
 *
 *   - "Best band" call from random noise → require >=10pp gap
 *     between the strongest and weakest qualifying bands. <10pp
 *     gap returns null (no actionable strategic insight).
 *
 *   - Comparing bands with different time horizons → all bands use
 *     the same 180-day window.
 *
 *   - LLM calling industry-norm strength a "venue strength" → prompt
 *     instructs the LLM to frame venue-relative not absolute.
 *
 *   - Insufficient venue data (newly onboarded, <20 resolved) →
 *     return null gracefully.
 *
 *   - LLM hallucinating per-band numbers → numbers-guard locks
 *     narration to {per-band N + conversion %, gap pp, total N,
 *     window_days}.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { callAIJson, CLAUDE_MODEL } from '@/lib/ai/client'
import { confidenceFor, buildCacheKey } from './confidence'
import { lookupCachedInsight, persistInsight } from './persist'
import type { ClassicalEvidence, InsightNarration } from './types'

export const STRENGTH_AREA_PROMPT_VERSION = 'strength-area-cohort.prompt.v1.0'

const ANALYSIS_WINDOW_DAYS = 180
const MIN_PER_BAND_RESOLVED = 5
const MIN_TOTAL_RESOLVED = 20
const MIN_BAND_GAP_PP = 10
const MIN_QUALIFYING_BANDS = 2

/** Guest-count bands. Edge inclusive on left, exclusive on right.
 *  200+ is open-ended ("very-large" segment that often differs
 *  operationally). */
const BANDS: Array<{ label: string; min: number; max: number | null }> = [
  { label: '0-50',     min: 0,   max: 51 },
  { label: '51-100',   min: 51,  max: 101 },
  { label: '101-150',  min: 101, max: 151 },
  { label: '151-200',  min: 151, max: 201 },
  { label: '200+',     min: 201, max: null },
]

interface BandStat {
  label: string
  resolved: number    // booked + completed + lost
  booked: number      // booked + completed
  conversion_pct: number  // booked / resolved * 100, rounded 1dp
  qualifies: boolean  // resolved >= MIN_PER_BAND_RESOLVED
}

interface ClassicalStrengthPayload {
  venueId: string
  windowDays: number
  total_resolved: number
  bands: BandStat[]
  strongest: BandStat | null
  weakest: BandStat | null
  gap_pp: number | null
}

export function bandForGuestCount(gc: number | null): BandStat['label'] | null {
  if (gc === null || gc < 0) return null
  for (const b of BANDS) {
    if (b.max === null) {
      if (gc >= b.min) return b.label
    } else {
      if (gc >= b.min && gc < b.max) return b.label
    }
  }
  return null
}

export function computeBandStats(rows: Array<{ status: string; guest_count_estimate: number | null }>): BandStat[] {
  const buckets: Record<string, { resolved: number; booked: number }> = {}
  for (const b of BANDS) buckets[b.label] = { resolved: 0, booked: 0 }

  for (const r of rows) {
    const label = bandForGuestCount(r.guest_count_estimate)
    if (!label) continue
    if (r.status === 'booked' || r.status === 'completed') {
      buckets[label].booked++
      buckets[label].resolved++
    } else if (r.status === 'lost') {
      buckets[label].resolved++
    }
  }

  return BANDS.map((b) => {
    const stats = buckets[b.label]
    const conversion_pct = stats.resolved > 0
      ? Math.round((stats.booked / stats.resolved) * 1000) / 10
      : 0
    return {
      label: b.label,
      resolved: stats.resolved,
      booked: stats.booked,
      conversion_pct,
      qualifies: stats.resolved >= MIN_PER_BAND_RESOLVED,
    }
  })
}

async function loadClassicalStrengthEvidence(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ClassicalStrengthPayload | null> {
  const cutoff = new Date(Date.now() - ANALYSIS_WINDOW_DAYS * 86_400_000).toISOString()

  const { data } = await supabase
    .from('weddings')
    .select('status, guest_count_estimate')
    .eq('venue_id', venueId)
    .gte('inquiry_date', cutoff)
    .in('status', ['booked', 'completed', 'lost'])
    .not('guest_count_estimate', 'is', null)

  const rows = ((data ?? []) as Array<{ status: string; guest_count_estimate: number | null }>)
  if (rows.length < MIN_TOTAL_RESOLVED) return null

  const bands = computeBandStats(rows)
  const qualifying = bands.filter((b) => b.qualifies)
  if (qualifying.length < MIN_QUALIFYING_BANDS) return null

  // Strongest = highest conversion among qualifying. Weakest = lowest.
  let strongest = qualifying[0]
  let weakest = qualifying[0]
  for (const b of qualifying) {
    if (b.conversion_pct > strongest.conversion_pct) strongest = b
    if (b.conversion_pct < weakest.conversion_pct) weakest = b
  }
  if (strongest.label === weakest.label) return null

  const gap_pp = Math.round((strongest.conversion_pct - weakest.conversion_pct) * 10) / 10
  if (gap_pp < MIN_BAND_GAP_PP) return null  // gap too small to be actionable

  return {
    venueId,
    windowDays: ANALYSIS_WINDOW_DAYS,
    total_resolved: rows.length,
    bands,
    strongest,
    weakest,
    gap_pp,
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

interface StrengthDiagnostic {
  reasoning: string
  recommendation: string
  confidence: number
}

export async function generateStrengthAreaCohort(
  supabase: SupabaseClient,
  venueId: string,
  force: boolean = false,
): Promise<{
  total_resolved: number
  strongest_label: string
  strongest_pct: number
  strongest_n: number
  weakest_label: string
  weakest_pct: number
  weakest_n: number
  gap_pp: number
  bands: Array<{ label: string; resolved: number; conversion_pct: number; qualifies: boolean }>
  reasoning: string
  recommendation: string
  confidence: number
  cached: boolean
} | null> {
  const classical = await loadClassicalStrengthEvidence(supabase, venueId)
  if (!classical || !classical.strongest || !classical.weakest || classical.gap_pp === null) return null

  const cacheKey = buildCacheKey({
    venueId,
    total: classical.total_resolved,
    strongest: classical.strongest.label,
    sPct: classical.strongest.conversion_pct,
    weakest: classical.weakest.label,
    wPct: classical.weakest.conversion_pct,
    gap: classical.gap_pp,
    bands: classical.bands.map((b) => `${b.label}:${b.resolved}:${b.conversion_pct}`).join('|'),
  })

  if (!force) {
    const cached = await lookupCachedInsight(
      supabase, venueId, 'strength_area_cohort', null, cacheKey,
    )
    if (cached) {
      const dp = cached.data_points as Partial<ClassicalStrengthPayload> & { recommendation?: string }
      return {
        total_resolved: classical.total_resolved,
        strongest_label: classical.strongest.label,
        strongest_pct: classical.strongest.conversion_pct,
        strongest_n: classical.strongest.resolved,
        weakest_label: classical.weakest.label,
        weakest_pct: classical.weakest.conversion_pct,
        weakest_n: classical.weakest.resolved,
        gap_pp: classical.gap_pp,
        bands: classical.bands.map((b) => ({
          label: b.label, resolved: b.resolved, conversion_pct: b.conversion_pct, qualifies: b.qualifies,
        })),
        reasoning: cached.body,
        recommendation: dp.recommendation ?? cached.action ?? '',
        confidence: cached.confidence,
        cached: true,
      }
    }
  }

  const aiName = await loadAiName(supabase, venueId)
  const bandTable = classical.bands
    .map((b) => `  - ${b.label}: ${b.resolved} resolved, ${b.conversion_pct}% conversion${b.qualifies ? '' : ' (insufficient data)'}`)
    .join('\n')

  const systemPrompt = `You are ${aiName}, helping a wedding-venue coordinator
read the venue's strength-area breakdown by guest-count band.

Output JSON:
  - reasoning: 1 short sentence comparing the strongest band to the
    weakest band. Reference the bands by NAME and the gap in pp.
  - recommendation: 1 sentence. Lean into the strongest band — name a
    concrete action (target marketing toward that segment, build a
    package for it, surface it in tour scripts). Briefly note the
    weakest band as a deprioritisation candidate.
  - confidence: 0.0-1.0. Higher with bigger total_resolved and bigger
    gap; lower when bands are barely qualifying.

CRITICAL RULES:
- Numbers in your output must come from the user prompt. The only
  numbers you may use are per-band conversion %, per-band N, the
  gap pp, and the total resolved count.
- Frame the strength as VENUE-RELATIVE ("you convert 51-100 better
  than 200+") — not absolute industry-norm ("0-50 always converts
  well"). The data is your venue's track record, not industry truth.
- Do NOT speculate about why one band converts better. Stick to the
  pattern + a strategic move grounded in the pattern.`

  const userPrompt = `STRENGTH-AREA COHORT BREAKDOWN

Window: last ${classical.windowDays} days
Total resolved weddings (booked + lost): ${classical.total_resolved}

Per-guest-count band:
${bandTable}

Strongest qualifying band:  ${classical.strongest.label} — ${classical.strongest.conversion_pct}% conversion (n=${classical.strongest.resolved})
Weakest qualifying band:    ${classical.weakest.label}   — ${classical.weakest.conversion_pct}% conversion (n=${classical.weakest.resolved})
Gap:                        ${classical.gap_pp}pp

Diagnose + recommend.`

  let result: StrengthDiagnostic | null = null
  try {
    const raw = await callAIJson<StrengthDiagnostic>({
      systemPrompt,
      userPrompt,
      maxTokens: 300,
      temperature: 0.3,
      venueId,
      taskType: 'strength_area_cohort',
      tier: 'sonnet',
      promptVersion: STRENGTH_AREA_PROMPT_VERSION,
    })
    if (raw && typeof raw.reasoning === 'string') {
      result = {
        reasoning: raw.reasoning.trim() || 'Strength-area gap detected between bands.',
        recommendation: (raw.recommendation ?? '').trim() || `Lean into the ${classical.strongest!.label} segment in marketing + tour positioning.`,
        confidence: typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0.5,
      }
    }
  } catch (err) {
    console.warn('[strength-area-cohort] LLM diagnostic failed:', err instanceof Error ? err.message : err)
  }

  if (!result) {
    result = {
      reasoning: `${classical.strongest.label} converts at ${classical.strongest.conversion_pct}% vs ${classical.weakest.conversion_pct}% on ${classical.weakest.label} (${classical.gap_pp}pp gap).`,
      recommendation: `Lean into the ${classical.strongest.label} segment — target marketing and tour positioning toward this band; deprioritise ${classical.weakest.label} until you find a differentiator for it.`,
      confidence: 0.45,
    }
  }

  const allowedNumbers: Array<number | string> = [
    classical.total_resolved,
    classical.windowDays,
    classical.gap_pp,
    classical.strongest.resolved,
    classical.strongest.conversion_pct,
    classical.weakest.resolved,
    classical.weakest.conversion_pct,
    ...classical.bands.flatMap((b) => [b.resolved, b.conversion_pct, b.booked]),
  ]

  const evidence: ClassicalEvidence = {
    cacheKey,
    numbers: allowedNumbers,
    payload: {
      ...classical,
      reasoning: result.reasoning,
      recommendation: result.recommendation,
    } as unknown as Record<string, unknown>,
    sampleSize: classical.total_resolved,
    effectSize: Math.min(1, classical.gap_pp / 50),  // 50pp gap → effect 1.0
  }
  const conf = confidenceFor({ sampleSize: evidence.sampleSize, effectSize: evidence.effectSize })

  const narration: InsightNarration = {
    title: `Strongest cohort: ${classical.strongest.label} (${classical.strongest.conversion_pct}% vs ${classical.weakest.conversion_pct}% weakest)`,
    body: result.reasoning,
    action: result.recommendation,
  }

  await persistInsight(supabase, {
    venueId,
    insightType: 'strength_area_cohort',
    contextId: null,
    category: 'venue_strategy',
    surfaceLayer: 'on_demand',
    classical: evidence,
    narration,
    llmModelUsed: CLAUDE_MODEL,
    promptVersionUsed: STRENGTH_AREA_PROMPT_VERSION,
    confidence: conf.value,
    surfacePriority: classical.gap_pp + classical.total_resolved,
    priority: classical.gap_pp >= 30 ? 'high'
      : classical.gap_pp >= 15 ? 'medium'
      : 'low',
  })

  return {
    total_resolved: classical.total_resolved,
    strongest_label: classical.strongest.label,
    strongest_pct: classical.strongest.conversion_pct,
    strongest_n: classical.strongest.resolved,
    weakest_label: classical.weakest.label,
    weakest_pct: classical.weakest.conversion_pct,
    weakest_n: classical.weakest.resolved,
    gap_pp: classical.gap_pp,
    bands: classical.bands.map((b) => ({
      label: b.label, resolved: b.resolved, conversion_pct: b.conversion_pct, qualifies: b.qualifies,
    })),
    reasoning: result.reasoning,
    recommendation: result.recommendation,
    confidence: conf.value,
    cached: false,
  }
}

// Pure helpers for unit tests.
export const __test__ = {
  bandForGuestCount,
  computeBandStats,
  BANDS,
  MIN_PER_BAND_RESOLVED,
  MIN_TOTAL_RESOLVED,
  MIN_BAND_GAP_PP,
}
