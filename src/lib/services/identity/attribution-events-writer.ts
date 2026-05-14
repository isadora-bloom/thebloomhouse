/**
 * Idempotent attribution_events writer.
 *
 * Anchor: migration 336_pattern_a_uniqueness.sql + Round 2 audit
 * (2026-05-14). The audit observed Zachary Gragan with 9 duplicate
 * attribution_events caused by concurrent calls to the resolver /
 * backtrack / link paths. Each path used .insert(rows) with no
 * uniqueness guard so two threads racing on the same candidate each
 * wrote the full signal set.
 *
 * The DB-level fix is the partial unique index from mig 336. This
 * helper is the application-level cooperator: it pre-filters rows
 * that already exist live, so the common case (idempotent re-run)
 * succeeds quietly without hitting the index. The index then acts
 * as the race-window backstop for the rare case where two threads
 * both pass the pre-check and try to insert.
 *
 * On 23505 (unique violation) we retry the pre-check once. The
 * second pre-check should include the racing writer's rows, so
 * the second insert sees nothing left to do and returns empty.
 *
 * Sage-side coupling: when a new attribution_event lands, the
 * affected wedding's narrative_cache is implicitly stale (the
 * journey changed). The count-drift check in
 * journey-narrative.ts catches INCREASES so the cache regenerates
 * on next request without us doing anything here. We only bust
 * explicitly for DECREASES, which happen during mig-time dedup
 * or operator-side reverts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface AttributionEventInsertRow {
  venue_id: string
  candidate_identity_id: string
  wedding_id: string
  signal_id: string | null
  source_platform: string
  confidence: number
  tier: string
  decided_by: 'auto' | 'ai' | 'coordinator' | string
  reasoning?: string | null
  is_first_touch: boolean
  // Callers compute bucket from a ternary that returns these literals
  // but TS often widens to string at the call site. Accept the wider
  // type here; the DB CHECK constraint enforces the narrow domain.
  bucket: string
  conflict_with_legacy_source: string | null
  signal_class?: 'source' | string
}

export interface AttributionEventInsertResult {
  data: Array<{ id: string; venue_id: string }>
  error: string | null
  skipped: number
}

export async function insertAttributionEventsIdempotent(
  supabase: SupabaseClient,
  rows: AttributionEventInsertRow[],
): Promise<AttributionEventInsertResult> {
  if (rows.length === 0) return { data: [], error: null, skipped: 0 }

  const filtered = await filterAlreadyLive(supabase, rows)
  if (filtered.rows.length === 0) {
    return { data: [], error: null, skipped: filtered.skipped }
  }

  const firstAttempt = await supabase
    .from('attribution_events')
    .insert(filtered.rows)
    .select('id, venue_id')

  if (!firstAttempt.error) {
    return {
      data: (firstAttempt.data ?? []) as Array<{ id: string; venue_id: string }>,
      error: null,
      skipped: filtered.skipped,
    }
  }

  if (firstAttempt.error.code !== '23505') {
    return { data: [], error: firstAttempt.error.message, skipped: filtered.skipped }
  }

  // Unique-violation backstop: another writer raced past our pre-check.
  // Re-run the pre-check so the racing writer's rows are visible, then
  // insert whatever's left.
  const retryFiltered = await filterAlreadyLive(supabase, filtered.rows)
  if (retryFiltered.rows.length === 0) {
    return { data: [], error: null, skipped: rows.length }
  }
  const retryAttempt = await supabase
    .from('attribution_events')
    .insert(retryFiltered.rows)
    .select('id, venue_id')
  if (retryAttempt.error) {
    return {
      data: [],
      error: `attribution insert retry: ${retryAttempt.error.message}`,
      skipped: filtered.skipped + retryFiltered.skipped,
    }
  }
  return {
    data: (retryAttempt.data ?? []) as Array<{ id: string; venue_id: string }>,
    error: null,
    skipped: filtered.skipped + retryFiltered.skipped,
  }
}

async function filterAlreadyLive(
  supabase: SupabaseClient,
  rows: AttributionEventInsertRow[],
): Promise<{ rows: AttributionEventInsertRow[]; skipped: number }> {
  // Group by (candidate_identity_id, wedding_id) so we batch one
  // SELECT per cluster instead of per-row.
  const checkKeys = new Map<
    string,
    { candidate_identity_id: string; wedding_id: string; signal_ids: string[] }
  >()
  for (const r of rows) {
    if (!r.signal_id) continue
    const key = `${r.candidate_identity_id}::${r.wedding_id}`
    let bucket = checkKeys.get(key)
    if (!bucket) {
      bucket = {
        candidate_identity_id: r.candidate_identity_id,
        wedding_id: r.wedding_id,
        signal_ids: [],
      }
      checkKeys.set(key, bucket)
    }
    bucket.signal_ids.push(r.signal_id)
  }

  const existing = new Set<string>()
  for (const bucket of checkKeys.values()) {
    if (bucket.signal_ids.length === 0) continue
    const { data } = await supabase
      .from('attribution_events')
      .select('signal_id')
      .eq('candidate_identity_id', bucket.candidate_identity_id)
      .eq('wedding_id', bucket.wedding_id)
      .in('signal_id', bucket.signal_ids)
      .is('reverted_at', null)
      .is('tombstoned_at', null)
    for (const row of data ?? []) {
      const sid = (row as { signal_id: string | null }).signal_id
      if (sid) existing.add(`${bucket.candidate_identity_id}::${bucket.wedding_id}::${sid}`)
    }
  }

  const kept: AttributionEventInsertRow[] = []
  let skipped = 0
  for (const r of rows) {
    if (!r.signal_id) {
      kept.push(r)
      continue
    }
    const fp = `${r.candidate_identity_id}::${r.wedding_id}::${r.signal_id}`
    if (existing.has(fp)) {
      skipped += 1
      continue
    }
    kept.push(r)
  }
  return { rows: kept, skipped }
}
