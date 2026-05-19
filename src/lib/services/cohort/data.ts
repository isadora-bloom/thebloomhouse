/**
 * D9 — cohort data loader.
 *
 * Loads the slice of the identity-first spine D9 computes over, once
 * per request, so every feature module (funnel, response-time, curve,
 * ...) shares one set of in-memory rows. At Rixey scale this is ~2K
 * couples + ~4K touchpoints — small enough to hold and index in TS.
 *
 * Scale note: text-patterns reads touchpoints.raw_payload (which can
 * carry full email bodies). For a venue with hundreds of thousands of
 * touchpoints this loader would need a windowed / streaming variant;
 * D9 v1 targets the re-imported Rixey instance. The orchestrator
 * applies an optional occurred_at lower bound to cap the load.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CohortData,
  CoupleRow,
  ProgressionRow,
  TouchpointRow,
} from './types'
import { fetchAllRows } from './helpers'

export interface LoadOptions {
  /** Inclusive lower bound on touchpoint occurred_at (ISO). When set,
   *  also bounds couples by created_at so the two stay consistent. */
  since?: string | null
}

export async function loadCohortData(
  supabase: SupabaseClient,
  venueId: string,
  opts: LoadOptions = {},
): Promise<CohortData> {
  const since = opts.since ?? null

  // Venue timezone — drives every weekday / hour / month bucket.
  const { data: venueRow } = await supabase
    .from('venues')
    .select('timezone')
    .eq('id', venueId)
    .maybeSingle()
  const timezone =
    venueRow && typeof venueRow.timezone === 'string' && venueRow.timezone
      ? venueRow.timezone
      : 'America/New_York'

  const couples = await fetchAllRows<CoupleRow>(() => {
    let q = supabase
      .from('couples')
      .select(
        'id, lifecycle_state, channel_scope, wedding_date, heat_score, created_at, primary_contact_name',
      )
      .eq('venue_id', venueId)
      .order('created_at', { ascending: true })
    if (since) q = q.gte('created_at', since)
    return q
  })

  const touchpoints = await fetchAllRows<TouchpointRow>(() => {
    let q = supabase
      .from('touchpoints')
      .select(
        'id, couple_id, channel, action_type, occurred_at, signal_tier, confidence_tier, raw_payload',
      )
      .eq('venue_id', venueId)
      .not('couple_id', 'is', null)
      .order('occurred_at', { ascending: true })
    if (since) q = q.gte('occurred_at', since)
    return q
  })

  // Progression events are keyed on couple_id, not venue_id. Scope via
  // the couple ids we just loaded (chunked to keep the `in` list sane).
  const coupleIds = couples.map((c) => c.id)
  const progression: ProgressionRow[] = []
  const CHUNK = 300
  for (let i = 0; i < coupleIds.length; i += CHUNK) {
    const slice = coupleIds.slice(i, i + CHUNK)
    const rows = await fetchAllRows<ProgressionRow>(() => {
      let q = supabase
        .from('couple_progression_events')
        .select('couple_id, occurred_at, event_type')
        .in('couple_id', slice)
      if (since) q = q.gte('occurred_at', since)
      return q
    })
    progression.push(...rows)
  }

  // Index touchpoints by couple. Already occurred_at-ASC from the query.
  const byCouple = new Map<string, TouchpointRow[]>()
  for (const tp of touchpoints) {
    if (!tp.couple_id) continue
    const list = byCouple.get(tp.couple_id)
    if (list) list.push(tp)
    else byCouple.set(tp.couple_id, [tp])
  }

  return { venueId, timezone, couples, touchpoints, progression, byCouple }
}
