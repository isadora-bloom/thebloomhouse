/**
 * Idempotent wedding_touchpoints writer for signal-linked touches.
 *
 * Anchor: migration 336_pattern_a_uniqueness.sql. Pre-336 the writers
 * at backtrack.ts:602 + :1164 did an existence check via
 * `metadata @> {"signal_id": ...}` then a plain .insert(). Race
 * window: two concurrent threads both miss the check, both insert,
 * touchpoint counts inflate, Sage's draft personalization reads
 * inflated counts via brain/inquiry.ts.
 *
 * Post-336:
 *   - signal_id is a real column (backfilled from metadata)
 *   - partial unique index on (wedding_id, signal_id) WHERE signal_id IS NOT NULL
 *
 * This helper does the pre-filter against the new column + handles
 * the 23505 backstop. Callers pass signal-linked touchpoint rows;
 * the helper enforces that signal_id is set.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface SignalTouchpointRow {
  venue_id: string
  wedding_id: string
  signal_id: string
  source: string | null
  medium: string | null
  touch_type: string
  occurred_at: string
  metadata: Record<string, unknown>
}

export interface TouchpointInsertResult {
  inserted: boolean
  skipped: boolean
  error: string | null
}

export async function insertTouchpointIdempotent(
  supabase: SupabaseClient,
  row: SignalTouchpointRow,
): Promise<TouchpointInsertResult> {
  // Pre-check via the new signal_id column.
  const { data: existing } = await supabase
    .from('wedding_touchpoints')
    .select('id')
    .eq('wedding_id', row.wedding_id)
    .eq('signal_id', row.signal_id)
    .limit(1)
  if ((existing ?? []).length > 0) {
    return { inserted: false, skipped: true, error: null }
  }

  // Ensure metadata also carries signal_id for backwards-compat
  // readers that still inspect metadata.signal_id.
  const metadata =
    row.metadata && (row.metadata as Record<string, unknown>).signal_id
      ? row.metadata
      : { ...(row.metadata ?? {}), signal_id: row.signal_id }

  const { error } = await supabase.from('wedding_touchpoints').insert({
    venue_id: row.venue_id,
    wedding_id: row.wedding_id,
    signal_id: row.signal_id,
    source: row.source,
    medium: row.medium,
    touch_type: row.touch_type,
    occurred_at: row.occurred_at,
    metadata,
  })

  if (!error) return { inserted: true, skipped: false, error: null }

  // Race-window backstop. Another writer landed the same
  // (wedding_id, signal_id) tuple between our pre-check and insert.
  // Treat as a clean skip.
  if (error.code === '23505') {
    return { inserted: false, skipped: true, error: null }
  }
  return { inserted: false, skipped: false, error: error.message }
}
