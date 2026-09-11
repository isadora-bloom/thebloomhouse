/**
 * `couples.first_seen_at`, the earliest moment this couple showed up at
 * all, on any channel, at any identity strength.
 *
 * Wave 3, HANDLE-IDENTITY-SPEC.md §3. Sibling of point-zero.ts, kept
 * separate on purpose: Point-Zero logic is delicate and set-once, and this
 * is neither. The two answer different questions.
 *
 *   first_seen_at  the first touchpoint. A follow from an account with no
 *                  name and no address sets it. It only ever moves EARLIER
 *                  (a replay that finds an older signal), never later.
 *   point_zero_at  the first moment the couple was known by a name AND a
 *                  reachable address. A handle is not reachable, so a
 *                  handle-only signal can never set it.
 *
 * The invariant that ties them together is `first_seen_at <= point_zero_at`,
 * and lifecycle-audit.ts reports any couple that breaks it. The ribbon on
 * the couple page reads first seen, then the discovery touchpoints, then
 * point zero, then the known-couple history, which is only honest if the
 * two timestamps are in that order.
 *
 * Best-effort by contract: never throws. The touchpoint has already landed.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { logEvent } from '@/lib/observability/logger'

export interface StampFirstSeenArgs {
  supabase: SupabaseClient
  venueId: string
  coupleId: string
  /** The signal's `occurred_at` (when it happened in the real world, not
   *  when Bloom ingested it). */
  occurredAt: string
}

export interface StampFirstSeenResult {
  /** True when the column was written (first ever set, or moved earlier). */
  updated: boolean
  /** The value now on the row, as far as this call knows. */
  firstSeenAt: string | null
}

/**
 * Set `first_seen_at` to min(existing, occurredAt).
 *
 * Two writes rather than one so both are race-safe without an RPC:
 *   - when the column is null, an `IS NULL`-filtered update claims it;
 *   - when the incoming time is earlier than the stored one, a
 *     `lt`-filtered update moves it back, and loses harmlessly to any
 *     concurrent writer that got there with an even earlier time.
 * Neither can ever move the timestamp forward.
 */
export async function stampFirstSeenAt(
  args: StampFirstSeenArgs,
): Promise<StampFirstSeenResult> {
  const { supabase, venueId, coupleId, occurredAt } = args
  if (!occurredAt || !Number.isFinite(Date.parse(occurredAt))) {
    return { updated: false, firstSeenAt: null }
  }

  try {
    const { data, error } = await supabase
      .from('couples')
      .select('first_seen_at')
      .eq('id', coupleId)
      .eq('venue_id', venueId)
      .maybeSingle()
    if (error) {
      logEvent({
        level: 'warn',
        msg: 'first_seen.read_failed',
        data: { venue_id: venueId, couple_id: coupleId, error: error.message },
      })
      return { updated: false, firstSeenAt: null }
    }

    const stored =
      (data as { first_seen_at: string | null } | null)?.first_seen_at ?? null

    if (stored === null) {
      const { data: claimed, error: claimErr } = await supabase
        .from('couples')
        .update({ first_seen_at: occurredAt })
        .eq('id', coupleId)
        .eq('venue_id', venueId)
        .is('first_seen_at', null)
        .select('id')
      if (claimErr) {
        logEvent({
          level: 'warn',
          msg: 'first_seen.write_failed',
          data: { venue_id: venueId, couple_id: coupleId, error: claimErr.message },
        })
        return { updated: false, firstSeenAt: null }
      }
      const won = Array.isArray(claimed) && claimed.length > 0
      // Lost the race: someone else claimed it. Fall through to the
      // move-earlier branch on the next signal rather than re-reading now.
      return { updated: won, firstSeenAt: won ? occurredAt : null }
    }

    if (Date.parse(occurredAt) >= Date.parse(stored)) {
      return { updated: false, firstSeenAt: stored }
    }

    const { error: moveErr } = await supabase
      .from('couples')
      .update({ first_seen_at: occurredAt })
      .eq('id', coupleId)
      .eq('venue_id', venueId)
      .gte('first_seen_at', occurredAt)
    if (moveErr) {
      logEvent({
        level: 'warn',
        msg: 'first_seen.move_failed',
        data: { venue_id: venueId, couple_id: coupleId, error: moveErr.message },
      })
      return { updated: false, firstSeenAt: stored }
    }
    return { updated: true, firstSeenAt: occurredAt }
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'first_seen.stamp_failed',
      data: {
        venue_id: venueId,
        couple_id: coupleId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
    return { updated: false, firstSeenAt: null }
  }
}
