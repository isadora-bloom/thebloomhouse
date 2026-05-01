/**
 * Cultural moments — propose-and-confirm flow + correlation channel
 * (T2-C / Playbook 17.4 + INS-19.5.8).
 *
 * Three roles:
 *   1. Reader for correlation-engine.ts (loadCulturalMomentsSeries)
 *      projects confirmed moments onto a per-day series for lag analysis.
 *   2. Service for the propose-and-confirm admin UI (proposeMoment,
 *      confirmMoment, dismissMoment).
 *   3. Auto-proposer hook (proposeFromTrendSpike) — call this with a
 *      detected search-trend spike + matching news embedding, and it
 *      drops a 'proposed' row for coordinator review.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExternalChannelSeries, SeriesPoint } from './types'
import { daysInRange } from './types'

export type CulturalMomentStatus = 'proposed' | 'confirmed' | 'dismissed' | 'archived'
export type CulturalMomentCategory =
  | 'celebrity_wedding'
  | 'aesthetic_shift'
  | 'generational_milestone'
  | 'industry_news'
  | 'macro_event'
  | 'platform_event'
  | 'other'

export interface CulturalMomentRow {
  id: string
  status: CulturalMomentStatus
  title: string
  description: string | null
  start_at: string
  end_at: string | null
  category: CulturalMomentCategory | null
  evidence: Record<string, unknown>
  influence_weight: number | null
  geo_scope: string | null
  proposed_by: 'system' | 'ai' | 'coordinator'
  reviewed_by: string | null
  reviewed_at: string | null
  created_at: string
  updated_at: string
}

/**
 * Load CONFIRMED cultural moments overlapping a window and project
 * them onto a per-day series. influence_weight is the per-day value;
 * for overlapping moments the values sum (a celebrity wedding + an
 * aesthetic shift on the same day means both effects apply additively).
 *
 * Channel id: 'cultural_moments'.
 */
export async function loadCulturalMomentsSeries(
  supabase: SupabaseClient,
  windowStart: Date,
  windowEnd: Date,
): Promise<ExternalChannelSeries> {
  const { data } = await supabase
    .from('cultural_moments')
    .select('start_at, end_at, influence_weight')
    .eq('status', 'confirmed')
    .lte('start_at', windowEnd.toISOString())
    .or(`end_at.is.null,end_at.gte.${windowStart.toISOString()}`)

  const dailySum = new Map<string, number>()
  for (const r of ((data ?? []) as Array<{
    start_at: string
    end_at: string | null
    influence_weight: number | null
  }>)) {
    const w = r.influence_weight ?? 0
    if (w === 0) continue
    const start = new Date(r.start_at)
    const end = r.end_at ? new Date(r.end_at) : windowEnd
    // Clamp to window so a 540-day aesthetic shift doesn't generate
    // tens of thousands of points outside our analysis frame.
    const clampedStart = start < windowStart ? windowStart : start
    const clampedEnd = end > windowEnd ? windowEnd : end
    if (clampedEnd < clampedStart) continue
    for (const dayKey of daysInRange(clampedStart, clampedEnd)) {
      dailySum.set(dayKey, (dailySum.get(dayKey) ?? 0) + w)
    }
  }

  const points: SeriesPoint[] = Array.from(dailySum.entries())
    .map(([dayKey, value]) => ({ dayKey, value }))
    .sort((a, b) => a.dayKey.localeCompare(b.dayKey))

  return { channel: 'cultural_moments', points }
}

export interface ProposeMomentArgs {
  title: string
  description?: string
  startAt: string
  endAt?: string | null
  category?: CulturalMomentCategory
  evidence?: Record<string, unknown>
  geoScope?: string | null
  proposedBy?: 'system' | 'ai' | 'coordinator'
}

export async function proposeMoment(
  supabase: SupabaseClient,
  args: ProposeMomentArgs,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!args.title?.trim() || !args.startAt) {
    return { ok: false, error: 'title and startAt required' }
  }
  const { data, error } = await supabase
    .from('cultural_moments')
    .insert({
      title: args.title.trim(),
      description: args.description?.trim() || null,
      start_at: args.startAt,
      end_at: args.endAt ?? null,
      category: args.category ?? null,
      evidence: args.evidence ?? {},
      geo_scope: args.geoScope ?? null,
      proposed_by: args.proposedBy ?? 'coordinator',
      status: 'proposed',
    })
    .select('id')
    .single()
  if (error || !data) return { ok: false, error: error?.message ?? 'insert failed' }
  return { ok: true, id: data.id as string }
}

export async function confirmMoment(
  supabase: SupabaseClient,
  momentId: string,
  reviewedBy: string | null,
  influenceWeight: number = 0,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (influenceWeight < -100 || influenceWeight > 100) {
    return { ok: false, error: 'influence_weight out of range (-100..100)' }
  }
  const { error } = await supabase
    .from('cultural_moments')
    .update({
      status: 'confirmed',
      influence_weight: influenceWeight,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', momentId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

export async function dismissMoment(
  supabase: SupabaseClient,
  momentId: string,
  reviewedBy: string | null,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await supabase
    .from('cultural_moments')
    .update({
      status: 'dismissed',
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', momentId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Auto-proposer hook for the AI/system path. Drops a row in
 * status='proposed' so the coordinator review queue surfaces it.
 * Coordinators confirm with a real influence_weight or dismiss.
 *
 * Caller responsibilities:
 *   - Fingerprint check before calling (don't propose duplicates of
 *     an existing proposed/confirmed moment with the same date+title)
 *   - Pass evidence (search-trend spike data, news embedding match,
 *     etc.) so the coordinator review UI has the why
 */
export async function proposeFromAutoDetection(
  supabase: SupabaseClient,
  args: Omit<ProposeMomentArgs, 'proposedBy'>,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  return proposeMoment(supabase, { ...args, proposedBy: 'ai' })
}
