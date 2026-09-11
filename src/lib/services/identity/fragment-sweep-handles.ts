/**
 * Fragment promotion by handle.
 *
 * Wave 3, HANDLE-IDENTITY-SPEC.md §2 + §5. This is the coalesce logic
 * moving out of the Backwards Tracer and under the linker, where it
 * belongs: the Tracer was a nightly sweep that guessed at fragment pairs
 * with the fuzzy scorer, and the spec retires it. What replaces it is
 * narrower and deterministic.
 *
 * The shape it exists for: somebody follows the venue on Instagram in
 * March. That is a handle and nothing else, so it lands as a fragment. In
 * June the same person fills in the inquiry form and writes their Instagram
 * handle in the box. The inquiry mints or attaches a couple, and at that
 * moment the March follow stops being anonymous. Every unpromoted fragment
 * in the venue carrying that same `(platform, handle)` is promoted onto the
 * couple, and any orphan touchpoint that came in with the fragment is
 * re-anchored to it.
 *
 * No judge, no score, no window. Same platform, same normalised handle, so
 * same person. That is the only rule, and it is why this can run inline on
 * every attach and mint without costing a model call.
 *
 * Two entry points:
 *   promoteFragmentsByHandle  one couple, called inline by the linker right
 *                             after a signal carrying handles lands.
 *   sweepFragmentsByHandle    whole venue, for the nightly cron (W26 wires
 *                             the dispatch; this is the function it calls).
 *
 * Writes: `fragments` UPDATE, `touchpoints` UPDATE, and the
 * `couple_merge_events` 'fragment_promoted' audit row the Tracer has always
 * written. That last one is an INSERT on a guarded table, which is why this
 * file is on the chokepoint list in check-cascade-only-writer.mjs, it is
 * the same cascade-internal promotion the Tracer was doing, under a name.
 *
 * Best-effort by contract: never throws. The attach or mint that triggered
 * it has already succeeded.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { writeOrLog } from '@/lib/db/write-or-log'
import { logEvent } from '@/lib/observability/logger'
import { normalizeHandles } from './handles'
import { stampFirstSeenAt } from './first-seen'
import type { HandlePlatform } from './sources/types'
import type { HandleMap } from './handle-merge'

/** Bound on how many unpromoted fragments a single pass will consider. A
 *  venue's unpromoted pool is small by construction; the cap is a seatbelt
 *  against a pathological backlog, not a paging scheme. */
const FRAGMENT_SCAN_LIMIT = 5000

export interface FragmentPromotion {
  fragmentId: string
  coupleId: string
  /** Which platform matched, and on what value. */
  platform: HandlePlatform
  handle: string
  /** Orphan touchpoints re-anchored onto the couple with the fragment. */
  touchpointsReanchored: number
}

export interface FragmentSweepResult {
  /** Unpromoted fragments considered. */
  scanned: number
  promoted: FragmentPromotion[]
}

interface FragmentRow {
  id: string
  channel: string
  external_id: string
  occurred_at: string
  handles: HandleMap | null
}

export interface PromoteFragmentsByHandleArgs {
  supabase: SupabaseClient
  venueId: string
  /** The couple the triggering signal landed on. */
  coupleId: string
  /** The handles that signal carried. Empty or null is a no-op. */
  handles: HandleMap | null | undefined
  /** Override the scan cap. Tests only. */
  limit?: number
}

/**
 * Promote every unpromoted fragment in the venue that shares a
 * `(platform, handle)` with `handles` onto `coupleId`.
 */
export async function promoteFragmentsByHandle(
  args: PromoteFragmentsByHandleArgs,
): Promise<FragmentSweepResult> {
  const { supabase, venueId, coupleId } = args
  const wanted = normalizeHandles(args.handles)
  if (!wanted) return { scanned: 0, promoted: [] }

  try {
    const fragments = await loadUnpromotedFragments(
      supabase,
      venueId,
      args.limit ?? FRAGMENT_SCAN_LIMIT,
    )
    const promoted: FragmentPromotion[] = []
    for (const fragment of fragments) {
      const hit = firstSharedHandle(wanted, fragment.handles)
      if (!hit) continue
      const done = await promoteOne(supabase, venueId, coupleId, fragment, hit)
      if (done) promoted.push(done)
    }
    return { scanned: fragments.length, promoted }
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'fragment_sweep.promote_failed',
      data: {
        venue_id: venueId,
        couple_id: coupleId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return { scanned: 0, promoted: [] }
  }
}

export interface SweepFragmentsByHandleArgs {
  supabase: SupabaseClient
  venueId: string
  limit?: number
}

export interface VenueFragmentSweepResult extends FragmentSweepResult {
  /** Distinct couples that gained at least one fragment. */
  couplesTouched: number
  /** Fragments whose handle sits on two or more live couples. Left alone
   *  deliberately: ambiguity is not evidence, and picking a winner here
   *  would be exactly the silent fuse the spine refuses everywhere else. */
  ambiguous: number
}

/**
 * Venue-wide pass for the nightly cron. Builds the `(platform, handle) →
 * couple` index once from the venue's live couples, then walks the
 * unpromoted fragments. A handle held by more than one live couple is
 * skipped and counted, never guessed at.
 */
export async function sweepFragmentsByHandle(
  args: SweepFragmentsByHandleArgs,
): Promise<VenueFragmentSweepResult> {
  const { supabase, venueId } = args
  const empty: VenueFragmentSweepResult = {
    scanned: 0,
    promoted: [],
    couplesTouched: 0,
    ambiguous: 0,
  }

  try {
    const { data, error } = await supabase
      .from('couples')
      .select('id, handles')
      .eq('venue_id', venueId)
      .is('merged_into_id', null)
      .limit(10000)
    if (error) {
      logEvent({
        level: 'warn',
        msg: 'fragment_sweep.couples_read_failed',
        data: { venue_id: venueId, error: error.message },
      })
      return empty
    }

    // key = `${platform}:${handle}`. A key seen on two live couples is
    // marked ambiguous and never resolves.
    const owner = new Map<string, string | null>()
    for (const row of (data ?? []) as Array<{ id: string; handles: HandleMap | null }>) {
      const handles = normalizeHandles(row.handles)
      if (!handles) continue
      for (const platform of Object.keys(handles) as HandlePlatform[]) {
        const value = handles[platform]
        if (!value) continue
        const key = `${platform}:${value}`
        owner.set(key, owner.has(key) ? null : row.id)
      }
    }
    if (owner.size === 0) return empty

    const fragments = await loadUnpromotedFragments(
      supabase,
      venueId,
      args.limit ?? FRAGMENT_SCAN_LIMIT,
    )
    const promoted: FragmentPromotion[] = []
    const touched = new Set<string>()
    let ambiguous = 0

    for (const fragment of fragments) {
      const handles = normalizeHandles(fragment.handles)
      if (!handles) continue
      for (const platform of Object.keys(handles) as HandlePlatform[]) {
        const value = handles[platform]
        if (!value) continue
        const key = `${platform}:${value}`
        if (!owner.has(key)) continue
        const coupleId = owner.get(key) ?? null
        if (!coupleId) {
          ambiguous += 1
          break
        }
        const done = await promoteOne(supabase, venueId, coupleId, fragment, {
          platform,
          handle: value,
        })
        if (done) {
          promoted.push(done)
          touched.add(coupleId)
        }
        break
      }
    }

    return {
      scanned: fragments.length,
      promoted,
      couplesTouched: touched.size,
      ambiguous,
    }
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'fragment_sweep.venue_sweep_failed',
      data: {
        venue_id: venueId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return empty
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function loadUnpromotedFragments(
  supabase: SupabaseClient,
  venueId: string,
  limit: number,
): Promise<FragmentRow[]> {
  const { data, error } = await supabase
    .from('fragments')
    .select('id, channel, external_id, occurred_at, handles')
    .eq('venue_id', venueId)
    .is('promoted_to_couple_id', null)
    .limit(limit)
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'fragment_sweep.fragments_read_failed',
      data: { venue_id: venueId, error: error.message },
    })
    return []
  }
  return ((data ?? []) as FragmentRow[]).filter((f) => f.handles)
}

function firstSharedHandle(
  wanted: HandleMap,
  fragmentHandles: HandleMap | null,
): { platform: HandlePlatform; handle: string } | null {
  const have = normalizeHandles(fragmentHandles)
  if (!have) return null
  for (const platform of Object.keys(wanted) as HandlePlatform[]) {
    const value = wanted[platform]
    if (value && have[platform] === value) return { platform, handle: value }
  }
  return null
}

/**
 * Link one fragment to one couple: set the promotion columns (guarded by
 * `IS NULL` so a re-run is a no-op), re-anchor any orphan touchpoint that
 * shares the fragment's channel + external id, and write the audit row.
 */
async function promoteOne(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string,
  fragment: FragmentRow,
  hit: { platform: HandlePlatform; handle: string },
): Promise<FragmentPromotion | null> {
  const { data: linked, error } = await supabase
    .from('fragments')
    .update({
      promoted_to_couple_id: coupleId,
      promoted_at: new Date().toISOString(),
    })
    .eq('id', fragment.id)
    .eq('venue_id', venueId)
    .is('promoted_to_couple_id', null)
    .select('id')
  if (error) {
    logEvent({
      level: 'warn',
      msg: 'fragment_sweep.link_failed',
      data: {
        venue_id: venueId,
        fragment_id: fragment.id,
        couple_id: coupleId,
        error: error.message,
      },
    })
    return null
  }
  // Lost the race, or already promoted. Either way this pass did nothing.
  if (!Array.isArray(linked) || linked.length === 0) return null

  // Re-anchor the fragment's own touchpoints. A fragment and a touchpoint
  // share (venue_id, channel, external_id) when both were written for the
  // same signal, which is how a fragment comes to have any. Only orphans
  // move: a touchpoint already on a couple is not ours to repoint.
  let touchpointsReanchored = 0
  const { data: moved, error: tpErr } = await supabase
    .from('touchpoints')
    .update({ couple_id: coupleId })
    .eq('venue_id', venueId)
    .eq('channel', fragment.channel)
    .eq('external_id', fragment.external_id)
    .is('couple_id', null)
    .select('id')
  if (tpErr) {
    logEvent({
      level: 'warn',
      msg: 'fragment_sweep.reanchor_failed',
      data: {
        venue_id: venueId,
        fragment_id: fragment.id,
        couple_id: coupleId,
        error: tpErr.message,
      },
    })
  } else if (Array.isArray(moved)) {
    touchpointsReanchored = moved.length
  }

  // The promoted fragment is now part of this couple's history, and it is
  // almost always OLDER than the signal that identified them, the March
  // follow against the June enquiry. So it can pull first_seen_at back.
  // This is the line that puts the first Instagram follow on the ribbon.
  await stampFirstSeenAt({
    supabase,
    venueId,
    coupleId,
    occurredAt: fragment.occurred_at,
  })

  const reason =
    `handle ${hit.platform}:${hit.handle} matched fragment ${fragment.id.slice(0, 8)}`
    + ` (${fragment.channel}, ${fragment.occurred_at})`
  await writeOrLog(
    supabase.from('couple_merge_events').insert({
      venue_id: venueId,
      event_type: 'fragment_promoted',
      primary_couple_id: coupleId,
      rule_triggered: 'handle_exact',
      confidence_tier: 'high',
      reason,
    }),
    { op: 'couple_merge_events.insert', venueId },
  )

  return {
    fragmentId: fragment.id,
    coupleId,
    platform: hit.platform,
    handle: hit.handle,
    touchpointsReanchored,
  }
}

/**
 * Convenience form used by enqueue.ts (W24): promote every fragment whose
 * handle matches one of this couple's stored handles. Loads the couple's
 * handle map itself so a caller that only has ids can use it.
 */
export async function sweepFragmentsForCouple(
  supabase: SupabaseClient,
  venueId: string,
  coupleId: string,
): Promise<{ scanned: number; promoted: number }> {
  const { data } = await supabase
    .from('couples')
    .select('handles')
    .eq('id', coupleId)
    .eq('venue_id', venueId)
    .maybeSingle()
  const handles = (data as { handles?: Record<string, string> | null } | null)?.handles ?? null
  if (!handles || Object.keys(handles).length === 0) return { scanned: 0, promoted: 0 }
  const res = await promoteFragmentsByHandle({
    supabase,
    venueId,
    coupleId,
    handles: handles as Parameters<typeof promoteFragmentsByHandle>[0]['handles'],
  })
  return { scanned: res.scanned, promoted: res.promoted.length }
}
