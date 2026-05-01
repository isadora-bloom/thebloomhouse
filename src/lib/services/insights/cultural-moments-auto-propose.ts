/**
 * T3-E: Cultural moments auto-propose from search-trend spike
 * detection (Playbook INS-19.5.8 + ARCH-19.8-D).
 *
 * The existing trends.ts `detectTrendDeviations` is a simple
 * 4w-vs-4w >20% baseline — fine for surfacing "interest is shifting"
 * dashboards but too noisy for proposing cultural moments. A 22%
 * one-week jump in an otherwise volatile term is not a moment;
 * a sustained 2-week +3σ deviation is.
 *
 * This module runs the STRONG spike detector + maps spikes to
 * proposed cultural moments with evidence. Bandaid traps avoided:
 *
 *   - Naive 20% threshold accepted as "spike" → we use z-score
 *     against a 12-week baseline excluding the last 2 weeks (no
 *     leakage), require either {persistence: |z|>=2.5 for both
 *     trailing weeks} OR {magnitude: |z|>=3.5 for one}.
 *   - Single-week blip surfacing as "moment" → persistence rule.
 *   - Seasonality false positives → longer baseline softens; calling
 *     code can extend to YoY same-week diff once data >52 weeks.
 *   - Duplicate proposals on consecutive cron runs → fingerprint
 *     dedup on (evidence.kind, evidence.term, evidence.weekStart);
 *     skip if any proposed/confirmed row matches.
 *   - Direction-blind proposals (spike DOWN in dampener = positive
 *     signal, spike DOWN in core demand = negative) → titleForSpike
 *     branches on (term-category × direction).
 *   - Auto-confirm bypassing review → always status='proposed' with
 *     proposed_by='ai'; coordinator must confirm before correlation
 *     engine sees it.
 *   - Cross-venue spam (national spike proposed N times for N venues)
 *     → dedup at the proposal level on (term, weekStart); first venue
 *     to detect wins, rest see the existing fingerprint and skip.
 *
 * Surface: /intel/cultural-moments shows proposed_by='ai' badges;
 * coordinator confirms with influence_weight or dismisses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { proposeFromAutoDetection } from '@/lib/services/external-context/cultural-moments'
import type { CulturalMomentCategory } from '@/lib/services/external-context/cultural-moments'

export const CULTURAL_MOMENTS_AUTO_PROPOSE_VERSION = 'cultural-moments-auto-propose.v1.0'

const DAY_MS = 86_400_000
const BASELINE_WEEKS = 12
const TRAILING_WEEKS = 2
const PERSISTENCE_Z_THRESHOLD = 2.5
const MAGNITUDE_Z_THRESHOLD = 3.5

// Mirrors trends.ts. Kept as a literal here rather than imported so
// the test layer doesn't need to reach into the SerpAPI module.
const TERM_CATEGORY: Record<string, 'core' | 'leading' | 'dampener'> = {
  'wedding venue': 'core',
  'wedding venues': 'core',
  'barn wedding venue': 'core',
  'outdoor wedding venue': 'core',
  'wedding photographer': 'core',
  'engagement ring': 'leading',
  'how to propose': 'leading',
  'divorce lawyer': 'dampener',
}

export interface TrendWeekPoint {
  week: string  // YYYY-MM-DD week-start
  interest: number
}

export interface SpikeReading {
  term: string
  termCategory: 'core' | 'leading' | 'dampener'
  weekStart: string
  weekEnd: string
  recentAvg: number
  baselineMean: number
  baselineStd: number
  zScore: number
  direction: 'up' | 'down'
  trigger: 'persistence' | 'magnitude'
}

interface MeanStdResult {
  mean: number
  std: number
}

/** Population mean + sample stddev. Returns std=1 when N<2 to avoid
 *  z-score div-by-zero (graceful collapse to identity diff). */
export function meanStd(values: number[]): MeanStdResult {
  if (values.length === 0) return { mean: 0, std: 1 }
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  if (values.length < 2) return { mean, std: 1 }
  const v = values.reduce((acc, x) => acc + (x - mean) * (x - mean), 0) / (values.length - 1)
  return { mean, std: Math.sqrt(v) || 1 }
}

/**
 * Detect strong spikes for a single term given its weekly time
 * series. Pure function; testable in isolation.
 *
 * Algorithm:
 *   1. Sort by week ascending.
 *   2. Need >= BASELINE_WEEKS + TRAILING_WEEKS = 14 weeks of data.
 *   3. Baseline = weeks [start, end - TRAILING_WEEKS) (exclude
 *      trailing 2 weeks so the baseline isn't contaminated by the
 *      candidate spike).
 *   4. Z-score the trailing 2 weeks against the baseline.
 *   5. Trigger:
 *        persistence: BOTH trailing weeks |z| >= 2.5, same direction
 *        magnitude:   AT LEAST ONE |z| >= 3.5
 *      Returns the higher-z week as the spike.
 *   6. Otherwise null.
 */
export function detectSpikeForTerm(
  term: string,
  termCategory: 'core' | 'leading' | 'dampener',
  series: TrendWeekPoint[],
): SpikeReading | null {
  if (series.length < BASELINE_WEEKS + TRAILING_WEEKS) return null

  const sorted = [...series].sort((a, b) => a.week.localeCompare(b.week))
  const baseline = sorted.slice(-BASELINE_WEEKS - TRAILING_WEEKS, -TRAILING_WEEKS)
  const trailing = sorted.slice(-TRAILING_WEEKS)

  if (baseline.length < BASELINE_WEEKS) return null

  const { mean, std } = meanStd(baseline.map((p) => p.interest))
  // Volatile baselines (std > mean*2 for non-zero means) are too noisy
  // to derive cultural moments from — defer rather than emit a spike
  // on top of a baseline that's already 80%-volatile. The std=1 floor
  // from meanStd protects against div-by-zero but doesn't protect us
  // from "everything looks like a spike" volatility.
  if (mean > 5 && std > mean * 1.5) return null

  const zs = trailing.map((p) => ({
    week: p.week,
    interest: p.interest,
    z: (p.interest - mean) / std,
  }))

  // Persistence: both trailing weeks past threshold AND same direction.
  const allPositive = zs.every((p) => p.z >= PERSISTENCE_Z_THRESHOLD)
  const allNegative = zs.every((p) => p.z <= -PERSISTENCE_Z_THRESHOLD)
  const persistence = allPositive || allNegative
  // Magnitude: at least one extreme spike.
  const magnitude = zs.some((p) => Math.abs(p.z) >= MAGNITUDE_Z_THRESHOLD)
  if (!persistence && !magnitude) return null

  // Pick the dominant week (largest |z|) as the spike anchor.
  const dominant = zs.reduce((acc, p) =>
    Math.abs(p.z) > Math.abs(acc.z) ? p : acc, zs[0])

  const recentAvg = trailing.reduce((s, p) => s + p.interest, 0) / trailing.length
  const trigger: SpikeReading['trigger'] = persistence ? 'persistence' : 'magnitude'

  return {
    term,
    termCategory,
    weekStart: trailing[0].week,
    weekEnd: trailing[trailing.length - 1].week,
    recentAvg: Math.round(recentAvg * 10) / 10,
    baselineMean: Math.round(mean * 10) / 10,
    baselineStd: Math.round(std * 100) / 100,
    zScore: Math.round(dominant.z * 100) / 100,
    direction: dominant.z > 0 ? 'up' : 'down',
    trigger,
  }
}

/**
 * Direction-aware title generation. The same +20% spike in core
 * demand vs. dampener vs. leading carries opposite implications:
 *   - core   ↑ → demand uplift
 *   - core   ↓ → demand softening
 *   - lead   ↑ → 3-12mo pipeline forming
 *   - lead   ↓ → 3-12mo pipeline weakening
 *   - damp   ↑ → sentiment headwind
 *   - damp   ↓ → sentiment tailwind
 *
 * The title is a short headline; the description (composed in
 * buildProposeArgs) carries the term + magnitude.
 */
export function titleForSpike(spike: SpikeReading): { title: string; category: CulturalMomentCategory } {
  const dir = spike.direction
  if (spike.termCategory === 'core') {
    return dir === 'up'
      ? { title: 'Wedding-search demand spike', category: 'industry_news' }
      : { title: 'Wedding-search demand softening', category: 'industry_news' }
  }
  if (spike.termCategory === 'leading') {
    return dir === 'up'
      ? { title: 'Engagement-intent spike (3-12mo pipeline)', category: 'generational_milestone' }
      : { title: 'Engagement-intent softening (3-12mo pipeline)', category: 'generational_milestone' }
  }
  // dampener
  return dir === 'up'
    ? { title: 'Sentiment headwind: divorce-search uptick', category: 'macro_event' }
    : { title: 'Sentiment tailwind: divorce-search dip', category: 'macro_event' }
}

/**
 * Fingerprint dedup. Looks for any non-dismissed cultural_moments
 * row whose evidence.kind = 'auto_trend_spike' AND evidence.term = X
 * AND evidence.weekStart = Y. If found, return its id (the caller
 * should skip insert).
 *
 * Postgres jsonb path query — uses the ->> operator (text extraction)
 * because cultural_moments doesn't have a GIN index on evidence and
 * we're comparing a small number of recent rows anyway.
 */
export async function findExistingProposalFingerprint(
  supabase: SupabaseClient,
  term: string,
  weekStart: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('cultural_moments')
    .select('id, evidence, status')
    .neq('status', 'dismissed')
    .gte('created_at', new Date(Date.now() - 60 * DAY_MS).toISOString())
    .limit(50)
  if (!data) return null
  for (const row of data as Array<{ id: string; evidence: Record<string, unknown> | null }>) {
    const ev = row.evidence ?? {}
    if (
      ev['kind'] === 'auto_trend_spike' &&
      ev['term'] === term &&
      ev['weekStart'] === weekStart
    ) {
      return row.id
    }
  }
  return null
}

/**
 * Build the propose-args payload from a spike. The evidence jsonb
 * carries enough context for the coordinator review UI to render
 * "why this was proposed" without re-querying.
 */
export function buildProposeArgs(spike: SpikeReading): {
  title: string
  description: string
  startAt: string
  endAt: null
  category: CulturalMomentCategory
  evidence: Record<string, unknown>
  geoScope: null
} {
  const { title, category } = titleForSpike(spike)
  const trigger = spike.trigger === 'persistence'
    ? `sustained ${TRAILING_WEEKS}-week deviation`
    : `single-week ${Math.abs(spike.zScore)}σ deviation`
  const description = [
    `Auto-detected from search-trends spike on '${spike.term}'.`,
    `Recent ${TRAILING_WEEKS}-week avg: ${spike.recentAvg} vs ${BASELINE_WEEKS}-week baseline ${spike.baselineMean} (σ=${spike.baselineStd}).`,
    `Trigger: ${trigger}, direction ${spike.direction}.`,
    'Coordinator: confirm with an influence_weight (-100..100) if this represents a real cultural/macro moment, or dismiss.',
  ].join(' ')

  return {
    title,
    description,
    startAt: new Date(Date.parse(spike.weekStart + 'T00:00:00Z')).toISOString(),
    endAt: null,
    category,
    evidence: {
      kind: 'auto_trend_spike',
      version: CULTURAL_MOMENTS_AUTO_PROPOSE_VERSION,
      term: spike.term,
      termCategory: spike.termCategory,
      weekStart: spike.weekStart,
      weekEnd: spike.weekEnd,
      recentAvg: spike.recentAvg,
      baselineMean: spike.baselineMean,
      baselineStd: spike.baselineStd,
      zScore: spike.zScore,
      direction: spike.direction,
      trigger: spike.trigger,
      detectedAt: new Date().toISOString(),
    },
    geoScope: null,  // National default; coordinator can refine on confirm.
  }
}

/**
 * Orchestrator: pull search-trend data for a metro, run spike
 * detection per-term, dedup, propose. Returns a summary the
 * caller (cron / API) can log.
 *
 * Per-venue (vs. global) because search_trends is metro-keyed; a
 * national spike will fire in many metros, but the dedup at
 * (term, weekStart) keeps the cultural_moments table from inflating.
 */
export async function autoProposeFromTrendSpikes(
  supabase: SupabaseClient,
  venueId: string,
): Promise<{
  spikesDetected: number
  proposed: number
  deduped: number
  errors: number
  details: Array<{ term: string; outcome: 'proposed' | 'deduped' | 'error'; momentId?: string; error?: string }>
}> {
  // Resolve venue's metro.
  const { data: venue } = await supabase
    .from('venues')
    .select('google_trends_metro')
    .eq('id', venueId)
    .maybeSingle()
  const metro = (venue?.google_trends_metro as string | null) ?? null
  if (!metro) {
    return { spikesDetected: 0, proposed: 0, deduped: 0, errors: 0, details: [] }
  }

  // Need at least 14 weeks back. Pull 16 to give ourselves margin.
  const cutoff = new Date(Date.now() - 16 * 7 * DAY_MS).toISOString().split('T')[0]
  const { data: rows } = await supabase
    .from('search_trends')
    .select('term, week, interest')
    .eq('metro', metro)
    .gte('week', cutoff)
    .order('week', { ascending: true })

  if (!rows || rows.length === 0) {
    return { spikesDetected: 0, proposed: 0, deduped: 0, errors: 0, details: [] }
  }

  // Group by term.
  const byTerm = new Map<string, TrendWeekPoint[]>()
  for (const r of rows as Array<{ term: string; week: string; interest: number }>) {
    if (!byTerm.has(r.term)) byTerm.set(r.term, [])
    byTerm.get(r.term)!.push({ week: r.week, interest: r.interest ?? 0 })
  }

  const details: Array<{ term: string; outcome: 'proposed' | 'deduped' | 'error'; momentId?: string; error?: string }> = []
  let spikesDetected = 0
  let proposed = 0
  let deduped = 0
  let errors = 0

  for (const [term, points] of byTerm) {
    const category = TERM_CATEGORY[term] ?? 'core'
    const spike = detectSpikeForTerm(term, category, points)
    if (!spike) continue
    spikesDetected++

    const existing = await findExistingProposalFingerprint(supabase, spike.term, spike.weekStart)
    if (existing) {
      deduped++
      details.push({ term: spike.term, outcome: 'deduped', momentId: existing })
      continue
    }

    const args = buildProposeArgs(spike)
    const result = await proposeFromAutoDetection(supabase, args)
    if (result.ok) {
      proposed++
      details.push({ term: spike.term, outcome: 'proposed', momentId: result.id })
    } else {
      errors++
      details.push({ term: spike.term, outcome: 'error', error: result.error })
    }
  }

  return { spikesDetected, proposed, deduped, errors, details }
}

// Re-exports for unit tests — pure helpers.
export const __test__ = {
  meanStd,
  detectSpikeForTerm,
  titleForSpike,
  buildProposeArgs,
  PERSISTENCE_Z_THRESHOLD,
  MAGNITUDE_Z_THRESHOLD,
  BASELINE_WEEKS,
  TRAILING_WEEKS,
}
