/**
 * Merging a signal's handles onto the couple it landed on.
 *
 * Wave 3, HANDLE-IDENTITY-SPEC.md §1. `couples.handles` (migration 398) is
 * the spine's record of who this couple is on each platform. Only the
 * linker path writes it, and the write rule is narrow:
 *
 *   - a platform the couple has no handle for is simply added;
 *   - a platform where the stored handle already equals the incoming one
 *     is a no-op;
 *   - a platform where the stored handle DIFFERS is a contradiction. The
 *     stored value stays. We do not overwrite, we do not pick a winner by
 *     recency, and we do not drop the incoming value on the floor: the
 *     caller logs it and queues it for a human.
 *
 * The third case is the whole reason this file exists. Silently replacing a
 * handle would let one mistyped inquiry-form field quietly repoint a
 * couple's Instagram identity, and nothing downstream would ever know. A
 * handle collision is either a typo, a re-used username, or two people
 * being treated as one, and all three want eyes on them.
 *
 * This module UPDATEs `couples`; it never inserts. The audit row for a
 * contradiction is written by the caller (route-by-tier / forwards-linker),
 * which is inside the cascade chokepoint surface.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'
import { normalizeHandles } from './handles'
import type { HandlePlatform } from './sources/types'

export type HandleMap = Partial<Record<HandlePlatform, string>>

/** One platform where the couple already holds a different handle. */
export interface HandleConflict {
  platform: HandlePlatform
  existing: string
  incoming: string
}

export interface HandleMergeOutcome {
  /** The map that should be stored: existing plus every non-conflicting
   *  addition. Conflicting platforms keep their existing value. */
  merged: HandleMap
  /** Platforms this merge added a handle for. */
  added: HandlePlatform[]
  /** Platforms where the incoming handle disagreed with the stored one.
   *  Nothing was overwritten; the caller queues these. */
  conflicts: HandleConflict[]
  /** True when `merged` differs from the existing map. */
  changed: boolean
}

/**
 * Pure union of two handle maps. Existing values win on a conflict and the
 * conflict is reported. Both sides are re-normalised so a caller that
 * skipped `normalizeHandle` cannot poison the store.
 */
export function mergeHandleMaps(
  existing: HandleMap | null | undefined,
  incoming: HandleMap | null | undefined,
): HandleMergeOutcome {
  const base: HandleMap = { ...(normalizeHandles(existing) ?? {}) }
  const next = normalizeHandles(incoming) ?? {}

  const added: HandlePlatform[] = []
  const conflicts: HandleConflict[] = []

  for (const platform of Object.keys(next) as HandlePlatform[]) {
    const value = next[platform]
    if (!value) continue
    const current = base[platform]
    if (!current) {
      base[platform] = value
      added.push(platform)
      continue
    }
    if (current === value) continue
    conflicts.push({ platform, existing: current, incoming: value })
  }

  return { merged: base, added, conflicts, changed: added.length > 0 }
}

export interface MergeHandlesArgs {
  supabase: SupabaseClient
  venueId: string
  coupleId: string
  handles: HandleMap | null | undefined
}

export interface MergeHandlesResult extends HandleMergeOutcome {
  /** True when the couples row was actually updated. */
  written: boolean
}

const EMPTY: MergeHandlesResult = {
  merged: {},
  added: [],
  conflicts: [],
  changed: false,
  written: false,
}

/**
 * Read the couple's stored handles, union the signal's in, and write back
 * only when something was added. Never throws: the touchpoint has already
 * landed by the time this runs and a stamping failure must not poison the
 * pipeline (same contract as point-zero.ts).
 */
export async function mergeHandlesIntoCouple(
  args: MergeHandlesArgs,
): Promise<MergeHandlesResult> {
  const { supabase, venueId, coupleId, handles } = args
  const incoming = normalizeHandles(handles)
  if (!incoming) return EMPTY

  try {
    const { data, error } = await supabase
      .from('couples')
      .select('handles')
      .eq('id', coupleId)
      .eq('venue_id', venueId)
      .maybeSingle()
    if (error) {
      logEvent({
        level: 'warn',
        msg: 'handles.read_failed',
        data: { venue_id: venueId, couple_id: coupleId, error: error.message },
      })
      return EMPTY
    }

    const stored = (data as { handles: HandleMap | null } | null)?.handles ?? null
    const outcome = mergeHandleMaps(stored, incoming)
    if (!outcome.changed) return { ...outcome, written: false }

    const { error: upErr } = await supabase
      .from('couples')
      .update({ handles: outcome.merged })
      .eq('id', coupleId)
      .eq('venue_id', venueId)
    if (upErr) {
      logEvent({
        level: 'warn',
        msg: 'handles.write_failed',
        data: { venue_id: venueId, couple_id: coupleId, error: upErr.message },
      })
      return { ...outcome, written: false }
    }
    return { ...outcome, written: true }
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'handles.merge_failed',
      data: {
        venue_id: venueId,
        couple_id: coupleId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return EMPTY
  }
}

/** One-line summary of a conflict set, for a reason string or audit row. */
export function describeHandleConflicts(conflicts: HandleConflict[]): string {
  return conflicts
    .map((c) => `${c.platform}: stored '${c.existing}' vs incoming '${c.incoming}'`)
    .join('; ')
}
