/**
 * Decay sweep.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §3 ("Decay sweep is a cron
 * job, daily, idempotent, batched per venue").
 *
 * Doctrine rule: flip a couple to 'ghost' when
 *   lifecycle_state IN ('resolved','channel_scoped')
 *   AND last_progression_at < now() - decay_window_days
 *   AND NOT EXISTS a couple_progression_events row in that window.
 * Booked never decays (excluded from the candidate set). Agents are a
 * separate class and also excluded.
 *
 * Two callers share this logic:
 *   - The Backwards Tracer's `decay_sweep` stage (one venue, wrapped
 *     in tracer_run_events telemetry).
 *   - The daily `heat_decay` cron, which runs it across every venue
 *     so decay happens nightly even for venues with no Tracer run.
 *
 * Idempotent: flipping an already-ghost couple is a no-op (the
 * candidate query only ever selects resolved / channel_scoped).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface DecaySweepResult {
  examined: number
  ghosted: number
}

/**
 * Decay one venue. Pure logic — no telemetry emission. The Tracer
 * stage wraps this with tracer_run_events; the cron wraps it with a
 * fleet summary.
 */
export async function decayStaleCouples(
  supabase: SupabaseClient,
  venueId: string,
): Promise<DecaySweepResult> {
  const { data: candidates, error: candErr } = await supabase
    .from('couples')
    .select('id, last_progression_at, decay_window_days')
    .eq('venue_id', venueId)
    .in('lifecycle_state', ['resolved', 'channel_scoped'])
    .not('last_progression_at', 'is', null)
    .limit(5000)
  if (candErr) {
    throw new Error(`decay: candidate lookup ${candErr.message}`)
  }

  const rows = (candidates ?? []) as Array<{
    id: string
    last_progression_at: string
    decay_window_days: number
  }>
  const now = Date.now()
  const toGhost: string[] = []

  for (const r of rows) {
    const ageMs = now - Date.parse(r.last_progression_at)
    const windowMs = (r.decay_window_days ?? 180) * 86_400_000
    if (ageMs <= windowMs) continue

    // Doctrine second guard: NOT EXISTS a recent progression event.
    // last_progression_at IS the latest event in steady state; the
    // re-check catches a progression event that landed mid-sweep.
    const sinceIso = new Date(now - windowMs).toISOString()
    const { count } = await supabase
      .from('couple_progression_events')
      .select('couple_id', { count: 'exact', head: true })
      .eq('couple_id', r.id)
      .gt('occurred_at', sinceIso)
    if ((count ?? 0) > 0) continue

    toGhost.push(r.id)
  }

  let ghosted = 0
  if (toGhost.length > 0) {
    const { error: updErr, count } = await supabase
      .from('couples')
      .update({ lifecycle_state: 'ghost' }, { count: 'exact' })
      .in('id', toGhost)
      .in('lifecycle_state', ['resolved', 'channel_scoped'])
    if (updErr) {
      throw new Error(`decay: update ${updErr.message}`)
    }
    ghosted = count ?? toGhost.length
  }

  return { examined: rows.length, ghosted }
}

export interface DecayFleetResult {
  venues_swept: number
  total_examined: number
  total_ghosted: number
  errors: string[]
}

/**
 * Daily fleet-wide decay. Called by the `heat_decay` cron. Per-venue
 * errors are isolated so one bad venue doesn't stop the sweep.
 */
export async function runDecaySweepAllVenues(
  supabase: SupabaseClient,
): Promise<DecayFleetResult> {
  const { data: venues, error } = await supabase
    .from('venues')
    .select('id')
    .order('created_at', { ascending: true })
  if (error) throw new Error(`decay: venue lookup ${error.message}`)

  const result: DecayFleetResult = {
    venues_swept: 0,
    total_examined: 0,
    total_ghosted: 0,
    errors: [],
  }

  for (const v of (venues ?? []) as Array<{ id: string }>) {
    try {
      const r = await decayStaleCouples(supabase, v.id)
      result.venues_swept += 1
      result.total_examined += r.examined
      result.total_ghosted += r.ghosted
    } catch (err) {
      result.errors.push(
        `${v.id}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  logEvent({
    level: 'info',
    msg: 'identity_decay.fleet_complete',
    data: {
      venues_swept: result.venues_swept,
      total_examined: result.total_examined,
      total_ghosted: result.total_ghosted,
      error_count: result.errors.length,
    },
  })
  return result
}
