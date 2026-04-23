/**
 * Phase 4 Task 43 — Problem-couple early warning signal.
 *
 * Computes a 0-100 friction score for a single inquiry by looking at patterns
 * that correlate with past friction tags on booked weddings at the same
 * venue. The signal learns per-venue — never cross-venue.
 *
 * Data dependency (per checklist): "do not build until tagging has real data".
 * `hasSufficientTrainingData` checks whether the venue has at least 5 booked
 * weddings with non-empty `friction_tags` arrays. Below that, scoring returns
 * `{ score: null, reason: 'insufficient_data' }` so UI surfaces can hide the
 * chip rather than show a score computed from noise.
 *
 * Signals considered (intentionally simple — this is the learning baseline):
 *   - inquiry mentions multiple price/budget concerns in first touchpoint
 *   - inquiry mentions competing venues explicitly
 *   - inquiry date is within 60 days (short-lead patterns correlate with
 *     friction in historical data for some venues)
 *   - source matches the source-of-highest-historical-friction at this venue
 *
 * The score is deliberately not used to gate responses — it's a signal only.
 */

import { createServiceClient } from '@/lib/supabase/service'

export const MIN_TAGGED_WEDDINGS_FOR_SIGNAL = 5

export interface FrictionScoreInput {
  venueId: string
  inquiryBody?: string
  inquiryDateIso?: string
  weddingDateIso?: string
  source?: string | null
}

export interface FrictionScoreResult {
  score: number | null
  reason: 'scored' | 'insufficient_data'
  signals: {
    budgetPressure: boolean
    mentionsCompetitors: boolean
    shortLead: boolean
    highFrictionSource: boolean
  }
  /** Top hit source per venue — exposed for the UI explainer. */
  highFrictionSource: string | null
}

export async function hasSufficientTrainingData(venueId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { count } = await supabase
    .from('weddings')
    .select('id', { count: 'exact', head: true })
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])
    .not('friction_tags', 'is', null)
    // `.neq('friction_tags', '[]')` on jsonb — Supabase accepts JSON literal.
    .neq('friction_tags', [] as unknown as string)
  return (count ?? 0) >= MIN_TAGGED_WEDDINGS_FOR_SIGNAL
}

async function findHighFrictionSource(venueId: string): Promise<string | null> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('weddings')
    .select('source, friction_tags')
    .eq('venue_id', venueId)
    .in('status', ['booked', 'completed'])
    .not('source', 'is', null)
  if (!data || data.length === 0) return null

  const bySource: Record<string, { total: number; withFriction: number }> = {}
  for (const w of data) {
    const source = (w.source as string) || 'unknown'
    if (!bySource[source]) bySource[source] = { total: 0, withFriction: 0 }
    bySource[source].total++
    const ft = w.friction_tags
    if (Array.isArray(ft) && ft.length > 0) bySource[source].withFriction++
  }
  let top: [string, number] | null = null
  for (const [source, stats] of Object.entries(bySource)) {
    if (stats.total < 3) continue
    const rate = stats.withFriction / stats.total
    if (rate >= 0.5 && (!top || rate > top[1])) top = [source, rate]
  }
  return top?.[0] ?? null
}

export async function computeFrictionScore(input: FrictionScoreInput): Promise<FrictionScoreResult> {
  const signals = {
    budgetPressure: /\b(tight|strict|limited|small) budget|we can'?t (afford|spend)|out of (our )?(budget|price)|too expensive/i.test(input.inquiryBody ?? ''),
    mentionsCompetitors: /\b(comparing|also looking|quote from|price from|better deal|other venues?)/i.test(input.inquiryBody ?? ''),
    shortLead: false,
    highFrictionSource: false,
  }

  if (input.inquiryDateIso && input.weddingDateIso) {
    const inquiry = new Date(input.inquiryDateIso)
    const wedding = new Date(input.weddingDateIso)
    const diffDays = (wedding.getTime() - inquiry.getTime()) / (1000 * 60 * 60 * 24)
    signals.shortLead = diffDays > 0 && diffDays < 60
  }

  if (!(await hasSufficientTrainingData(input.venueId))) {
    return { score: null, reason: 'insufficient_data', signals, highFrictionSource: null }
  }

  const highFrictionSource = await findHighFrictionSource(input.venueId)
  if (highFrictionSource && input.source && input.source === highFrictionSource) {
    signals.highFrictionSource = true
  }

  // Simple additive score. Weights chosen so any single signal yields ~30-35,
  // two signals yield 55-65 (warning threshold), three signals yield 80+
  // (strong warning). We do not bucket — callers decide.
  let score = 0
  if (signals.budgetPressure) score += 30
  if (signals.mentionsCompetitors) score += 25
  if (signals.shortLead) score += 20
  if (signals.highFrictionSource) score += 30

  return {
    score: Math.min(100, score),
    reason: 'scored',
    signals,
    highFrictionSource,
  }
}
