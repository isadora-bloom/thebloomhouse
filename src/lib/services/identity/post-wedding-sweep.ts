/**
 * Post-wedding sweep - flip booked -> completed when wedding_date passes.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §3 (lifecycle clock, 2026-05-20
 * update). 'completed' is the new terminal-positive state for couples
 * whose wedding has already occurred. 'booked' is now reserved for
 * pre-wedding signed-contract state.
 *
 * Doctrine notes:
 *  - 'completed' counts as engaged for funnel ratios + cohort metrics.
 *    The cohort loader still treats 'booked' AND 'completed' as positive
 *    outcomes; this sweep is a labelling correction, not a metric
 *    change.
 *  - Idempotent: only flips couples whose current state is exactly
 *    'booked' AND wedding_date < now. Re-running yields zero changes.
 *  - Multi-venue safe. Caller scopes by venueId.
 *  - The sweep does NOT touch 'resolved' couples whose wedding_date has
 *    passed (those never got contracted; transitioning them to
 *    completed would lie about the outcome).
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface PostWeddingSweepResult {
  venueId: string
  bookedScanned: number
  completedTransitioned: number
  errors: string[]
  latencyMs: number
}

export async function sweepPastWeddingsToCompleted(
  supabase: SupabaseClient,
  venueId: string,
  options: { limit?: number } = {},
): Promise<PostWeddingSweepResult> {
  const started = Date.now()
  const limit = options.limit ?? 1000
  const errors: string[] = []

  // Cutoff: today's UTC date string. wedding_date is a DATE column.
  // We use < today (not <= today) so a wedding happening today still
  // reads as 'booked'.
  const today = new Date().toISOString().slice(0, 10)

  const { data: couples, error: lookupErr } = await supabase
    .from('couples')
    .select('id, wedding_date, lifecycle_state')
    .eq('venue_id', venueId)
    .eq('lifecycle_state', 'booked')
    .not('wedding_date', 'is', null)
    .lt('wedding_date', today)
    .limit(limit)
  if (lookupErr) {
    errors.push(`lookup: ${lookupErr.message}`)
    return {
      venueId,
      bookedScanned: 0,
      completedTransitioned: 0,
      errors,
      latencyMs: Date.now() - started,
    }
  }
  const eligible = (couples ?? []) as Array<{ id: string }>
  if (eligible.length === 0) {
    return {
      venueId,
      bookedScanned: 0,
      completedTransitioned: 0,
      errors,
      latencyMs: Date.now() - started,
    }
  }

  // Bulk update. Re-check the predicates server-side to prevent any
  // race where a status changed between the read and the write.
  const ids = eligible.map((c) => c.id)
  const { error: updateErr, count } = await supabase
    .from('couples')
    .update({ lifecycle_state: 'completed' }, { count: 'exact' })
    .in('id', ids)
    .eq('lifecycle_state', 'booked')
    .lt('wedding_date', today)
  if (updateErr) {
    errors.push(`update: ${updateErr.message}`)
    return {
      venueId,
      bookedScanned: eligible.length,
      completedTransitioned: 0,
      errors,
      latencyMs: Date.now() - started,
    }
  }

  return {
    venueId,
    bookedScanned: eligible.length,
    completedTransitioned: count ?? 0,
    errors,
    latencyMs: Date.now() - started,
  }
}
