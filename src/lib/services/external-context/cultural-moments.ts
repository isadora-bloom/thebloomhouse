/**
 * Cultural moments — propose-and-confirm flow + correlation channel
 * (T2-C / Playbook 17.4 + INS-19.5.8).
 *
 * Three roles:
 *   1. Reader for correlation-engine.ts (loadCulturalMomentsSeries)
 *      projects confirmed moments onto a per-day series for lag analysis.
 *   2. Service for the propose-and-confirm admin UI (proposeMoment,
 *      confirmMoment, dismissMoment, snoozeMoment, clearVenueMomentDecision).
 *   3. Auto-proposer hook (proposeFromAutoDetection) — call this with a
 *      detected search-trend spike + matching news embedding, and it
 *      drops a 'proposed' row for coordinator review.
 *
 * Migration 167 (2026-05-02): cultural_moments stays GLOBAL (any venue
 * can propose; geo_scope handles regional cuts). Confirmation/dismissal
 * is PER-VENUE in venue_cultural_moment_state. The reader and the
 * confirm/dismiss helpers now require a venueId; the global
 * cultural_moments.status remains an admin-summary rollup ("at least
 * one venue elevated this") and the influence_weight stays a single
 * global field for now.
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
 * Per migration 167 the confirmation state lives in
 * venue_cultural_moment_state — pass `venueId` so the engine reads
 * THIS venue's confirmed moments rather than every venue's. Callers
 * that need the legacy global behaviour (e.g. nothing today, but kept
 * as an escape hatch) pass venueId=null.
 *
 * Channel id: 'cultural_moments'.
 */
export async function loadCulturalMomentsSeries(
  supabase: SupabaseClient,
  windowStart: Date,
  windowEnd: Date,
  venueId: string | null = null,
): Promise<ExternalChannelSeries> {
  let confirmedIds: string[] | null = null
  if (venueId) {
    const { data: stateRows } = await supabase
      .from('venue_cultural_moment_state')
      .select('cultural_moment_id')
      .eq('venue_id', venueId)
      .eq('state', 'confirmed')
    confirmedIds = ((stateRows ?? []) as Array<{ cultural_moment_id: string }>).map(
      (r) => r.cultural_moment_id,
    )
    // Short-circuit: this venue has confirmed nothing → empty series.
    // (Avoids a `cultural_moments WHERE id IN ()` query that some
    // PostgREST versions reject.)
    if (confirmedIds.length === 0) {
      return { channel: 'cultural_moments', points: [] }
    }
  }

  const baseQuery = supabase
    .from('cultural_moments')
    .select('start_at, end_at, influence_weight')
    .lte('start_at', windowEnd.toISOString())
    .or(`end_at.is.null,end_at.gte.${windowStart.toISOString()}`)
  const query = confirmedIds
    ? baseQuery.in('id', confirmedIds)
    : baseQuery.eq('status', 'confirmed')
  const { data } = await query

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

/**
 * Confirm a cultural moment FOR A VENUE (migration 167).
 *
 * Writes to venue_cultural_moment_state — the per-venue decision is
 * what the correlation engine reads. Also nudges the global
 * cultural_moments.status to 'confirmed' (admin-summary level: "at
 * least one venue elevated this moment") and stamps influence_weight +
 * reviewed_at. Multiple venues confirming the same moment all
 * upsert into venue_cultural_moment_state independently; the global
 * row's influence_weight is last-write-wins.
 *
 * Note on note: capped to 280 chars in the app layer to keep the rationale
 * snippet-sized. DB column is text (unbounded) for safety.
 */
export async function confirmMoment(
  supabase: SupabaseClient,
  momentId: string,
  venueId: string,
  reviewedBy: string | null,
  influenceWeight: number = 0,
  note?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (influenceWeight < -100 || influenceWeight > 100) {
    return { ok: false, error: 'influence_weight out of range (-100..100)' }
  }
  if (!venueId) return { ok: false, error: 'venueId required' }

  // Per-venue decision (the source of truth for engine reads).
  const { error: stateErr } = await supabase
    .from('venue_cultural_moment_state')
    .upsert(
      {
        venue_id: venueId,
        cultural_moment_id: momentId,
        state: 'confirmed',
        decided_by: reviewedBy,
        decided_at: new Date().toISOString(),
        note: note ? note.slice(0, 280) : null,
      },
      { onConflict: 'venue_id,cultural_moment_id' },
    )
  if (stateErr) return { ok: false, error: stateErr.message }

  // Global status bump — keeps the admin-summary view of "at least one
  // venue thinks this is real." influence_weight is last-write-wins;
  // could be split per-venue in a future migration if a real conflict
  // emerges (Hawthorne weighs +35, Crestwood weighs +12 for the same
  // moment).
  const { error: globalErr } = await supabase
    .from('cultural_moments')
    .update({
      status: 'confirmed',
      influence_weight: influenceWeight,
      reviewed_by: reviewedBy,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', momentId)
  if (globalErr) return { ok: false, error: globalErr.message }
  return { ok: true }
}

/**
 * Dismiss a cultural moment FOR A VENUE (migration 167).
 *
 * Writes to venue_cultural_moment_state with state='dismissed'. Does
 * NOT mutate the global cultural_moments.status — other venues may
 * still want to use this moment. (A dedicated admin path could
 * archive a moment globally if every venue dismisses it; out of scope
 * for this stream.)
 */
export async function dismissMoment(
  supabase: SupabaseClient,
  momentId: string,
  venueId: string,
  reviewedBy: string | null,
  note?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!venueId) return { ok: false, error: 'venueId required' }
  const { error } = await supabase
    .from('venue_cultural_moment_state')
    .upsert(
      {
        venue_id: venueId,
        cultural_moment_id: momentId,
        state: 'dismissed',
        decided_by: reviewedBy,
        decided_at: new Date().toISOString(),
        note: note ? note.slice(0, 280) : null,
      },
      { onConflict: 'venue_id,cultural_moment_id' },
    )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Snooze a cultural moment FOR A VENUE — UI lifecycle helper. Treated
 * like "not decided" by the engine reads.
 */
export async function snoozeMoment(
  supabase: SupabaseClient,
  momentId: string,
  venueId: string,
  reviewedBy: string | null,
  note?: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!venueId) return { ok: false, error: 'venueId required' }
  const { error } = await supabase
    .from('venue_cultural_moment_state')
    .upsert(
      {
        venue_id: venueId,
        cultural_moment_id: momentId,
        state: 'snoozed',
        decided_by: reviewedBy,
        decided_at: new Date().toISOString(),
        note: note ? note.slice(0, 280) : null,
      },
      { onConflict: 'venue_id,cultural_moment_id' },
    )
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}

/**
 * Clear a venue's decision — returns to the "not decided" state for
 * the queue UI.
 */
export async function clearVenueMomentDecision(
  supabase: SupabaseClient,
  momentId: string,
  venueId: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!venueId) return { ok: false, error: 'venueId required' }
  const { error } = await supabase
    .from('venue_cultural_moment_state')
    .delete()
    .eq('venue_id', venueId)
    .eq('cultural_moment_id', momentId)
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
