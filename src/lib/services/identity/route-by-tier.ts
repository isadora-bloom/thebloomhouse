/**
 * Shared tier-routing primitive for the Backwards Tracer and the
 * Forwards Linker.
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §2 + §4 + §5. Once the
 * matcher (+ optional LLM judge) lands on a final tier, the action
 * the system takes is identical regardless of which pipeline got
 * here. This helper IS that action — both `processSignal` in the
 * Tracer and `linkSignal` in the Linker call it.
 *
 * Decision table
 * --------------
 *   high             → INSERT touchpoint attached to matched couple
 *   medium / low     → INSERT orphan touchpoint (couple_id NULL) +
 *                       INSERT candidate_match row pointing at the
 *                       matched couple (operator-confirmed in Phase E)
 *   below_threshold  → signal has sufficient identity (§C.2)?
 *                       yes → MINT a channel-scoped couple + attach
 *                             touchpoint (advisory-locked, T8.1b)
 *                       no  → INSERT fragment (no couple link)
 *
 * Idempotency
 * -----------
 * The insert helpers (insertTouchpoint, insertFragment) return
 * inserted=false on 23505 conflict. Re-routing the same signal is
 * a no-op at the DB level.
 *
 * Why a separate file
 * -------------------
 * Tracer's processSignal had its own copy of this logic; Linker's
 * linkSignal had a near-identical copy. Two writers, one decision
 * table, drift over time guaranteed. Centralising here means any
 * future change (e.g., agent-tier promotion, channel-scoped
 * pre-flight) lands in exactly one place.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { MatcherVerdict, MatchTier } from './matcher'
import type { NormalizedSignal } from './sources/types'
import {
  insertCandidateMatch,
  insertFragment,
  insertTouchpoint,
} from './tracer'
import { recordProgressionIfEligible } from './progression'
import { maybeResurrectGhost } from './resurrection'
import { hasSufficientIdentity, lockAndMintCouple } from './mint-couple'
import { writeOrLog } from '@/lib/db/write-or-log'
import { logEvent } from '@/lib/observability/logger'
import { describeHandleConflicts, mergeHandlesIntoCouple } from './handle-merge'
import { stampFirstSeenAt } from './first-seen'
import { promoteFragmentsByHandle } from './fragment-sweep'

export type TierRoutingAction =
  | 'attached'
  | 'candidate_medium'
  | 'candidate_low'
  | 'minted'
  | 'fragment'
  | 'duplicate'

export interface TierRoutingResult {
  action: TierRoutingAction
  touchpoint_id: string | null
  touchpoint_inserted: boolean
  fragment_inserted: boolean
  candidate_match_queued: boolean
  /** True when the below_threshold branch minted a new channel-scoped
   *  couple (as opposed to attaching to one the RPC's re-check found). */
  couple_minted: boolean
  matched_couple_id: string | null
}

export interface TierRoutingArgs {
  supabase: SupabaseClient
  venueId: string
  signal: NormalizedSignal
  /** Highest-scoring couple from the matcher pass. null when no candidate. */
  best: { coupleId: string; verdict: MatcherVerdict } | null
  /** Tier AFTER any LLM judge adjustment. Caller is responsible for invoking
   *  the judge and resolving the verdict. */
  finalTier: MatchTier
  /** Free-form extension appended to the matcher reason (e.g., judge note). */
  reasonExtra?: string
}

/**
 * What the handle stamp did, so the caller can put it in the link reason
 * and the telemetry row.
 */
export interface HandleStampOutcome {
  /** Platforms added to `couples.handles` by this signal. */
  handlesAdded: string[]
  /** Per-platform disagreements. Nothing was overwritten. */
  handleConflicts: string[]
  /** True when `first_seen_at` was set or moved earlier. */
  firstSeenUpdated: boolean
  /** Fragments promoted onto the couple by a shared handle. */
  fragmentsPromoted: number
}

const NO_STAMP: HandleStampOutcome = {
  handlesAdded: [],
  handleConflicts: [],
  firstSeenUpdated: false,
  fragmentsPromoted: 0,
}

/**
 * Wave 3 post-attach stamp (HANDLE-IDENTITY-SPEC.md §1 + §2 + §3).
 *
 * Runs after a touchpoint lands on a couple, whether it attached, minted,
 * or came in on the legacy-wedding fast path. Three things, in order:
 *
 *   1. merge the signal's handles into `couples.handles`. A platform where
 *      the couple already holds a DIFFERENT handle is never overwritten:
 *      the stored value stays, and the disagreement gets an audit row and
 *      a line in the link reason so a human sees it. Silently replacing a
 *      handle is how one mistyped form field would repoint a couple's
 *      Instagram identity with nothing downstream any the wiser.
 *   2. set `first_seen_at` to min(existing, occurred_at). A handle-only
 *      signal counts, and that is the whole point of the column. It only ever
 *      moves earlier.
 *   3. promote every unpromoted fragment in the venue carrying the same
 *      (platform, handle) onto this couple, re-anchoring their orphan
 *      touchpoints. Deterministic, no judge.
 *
 * Best-effort by contract: never throws. The touchpoint is already written.
 */
export async function stampHandlesAndFirstSeen(args: {
  supabase: SupabaseClient
  venueId: string
  coupleId: string
  signal: NormalizedSignal
}): Promise<HandleStampOutcome> {
  const { supabase, venueId, coupleId, signal } = args
  const out: HandleStampOutcome = { ...NO_STAMP, handlesAdded: [], handleConflicts: [] }

  try {
    if (signal.handles) {
      const merged = await mergeHandlesIntoCouple({
        supabase,
        venueId,
        coupleId,
        handles: signal.handles,
      })
      out.handlesAdded = merged.added
      if (merged.conflicts.length > 0) {
        const detail = describeHandleConflicts(merged.conflicts)
        out.handleConflicts = merged.conflicts.map((c) => c.platform)
        logEvent({
          level: 'warn',
          msg: 'handles.contradiction',
          data: {
            venue_id: venueId,
            couple_id: coupleId,
            external_id: signal.external_id,
            conflicts: detail,
          },
        })
        // Queue it where an operator will find it: the couple's own audit
        // ledger, alongside merges and resurrections.
        await writeOrLog(
          supabase.from('couple_merge_events').insert({
            venue_id: venueId,
            event_type: 'handle_contradiction',
            primary_couple_id: coupleId,
            rule_triggered: 'handle_stamp',
            confidence_tier: 'medium',
            reason: `signal ${signal.channel}:${signal.external_id}: ${detail}`,
          }),
          { op: 'couple_merge_events.insert', venueId },
        )
      }
    }

    const firstSeen = await stampFirstSeenAt({
      supabase,
      venueId,
      coupleId,
      occurredAt: signal.occurred_at,
    })
    out.firstSeenUpdated = firstSeen.updated

    if (signal.handles) {
      const swept = await promoteFragmentsByHandle({
        supabase,
        venueId,
        coupleId,
        handles: signal.handles,
      })
      out.fragmentsPromoted = swept.promoted.length
    }
  } catch (err) {
    logEvent({
      level: 'warn',
      msg: 'handles.stamp_failed',
      data: {
        venue_id: venueId,
        couple_id: coupleId,
        error: err instanceof Error ? err.message : String(err),
      },
    })
  }
  return out
}

export async function applyTierRouting(
  args: TierRoutingArgs,
): Promise<TierRoutingResult> {
  const { supabase, venueId, signal, best, finalTier } = args
  const reasonExtra = args.reasonExtra ?? ''

  const empty: TierRoutingResult = {
    action: 'fragment',
    touchpoint_id: null,
    touchpoint_inserted: false,
    fragment_inserted: false,
    candidate_match_queued: false,
    couple_minted: false,
    matched_couple_id: null,
  }

  if (finalTier === 'high' && best) {
    const tp = await insertTouchpoint(supabase, venueId, best.coupleId, signal)
    // Bump the couple's progression clock if this signal is an inbound,
    // progression-eligible action type (§3 Don't skip #1).
    if (tp.inserted) {
      await recordProgressionIfEligible({
        supabase,
        coupleId: best.coupleId,
        signal,
        touchpointId: tp.touchpoint_id,
      })
      // §9: a high-tier signal landing on a Ghost couple resurrects
      // them. No-ops when the couple isn't a Ghost or the triggering
      // identifier is blacklisted against this couple.
      await maybeResurrectGhost({
        supabase,
        venueId,
        coupleId: best.coupleId,
        signal,
      })
    }
    return {
      ...empty,
      action: tp.inserted ? 'attached' : 'duplicate',
      touchpoint_id: tp.touchpoint_id,
      touchpoint_inserted: tp.inserted,
      matched_couple_id: best.coupleId,
    }
  }

  if ((finalTier === 'medium' || finalTier === 'low') && best) {
    const tp = await insertTouchpoint(supabase, venueId, null, signal)
    let queued = false
    if (tp.touchpoint_id) {
      await insertCandidateMatch(
        supabase,
        venueId,
        best.coupleId,
        'couple',
        tp.touchpoint_id,
        'touchpoint',
        finalTier,
        best.verdict.reason + reasonExtra,
      )
      queued = true
    }
    return {
      ...empty,
      action: finalTier === 'medium' ? 'candidate_medium' : 'candidate_low',
      touchpoint_id: tp.touchpoint_id,
      touchpoint_inserted: tp.inserted,
      candidate_match_queued: queued,
      matched_couple_id: best.coupleId,
    }
  }

  // below_threshold → the matcher placed this signal against no
  // existing couple. §C.2 (Appendix C): a signal WITH sufficient
  // identity (a reachable identifier OR a real two-token name) IS a
  // couple in its own right — mint a channel-scoped one. Only an
  // identity-poor signal (anonymous save, "Madison B." with no
  // identifier) becomes a Fragment.
  if (hasSufficientIdentity(signal)) {
    const mint = await lockAndMintCouple(supabase, venueId, signal)
    if (mint.coupleId && mint.touchpointInserted) {
      // Bump the couple's progression clock for an inbound,
      // progression-eligible action type (§3 Don't skip #1).
      await recordProgressionIfEligible({
        supabase,
        coupleId: mint.coupleId,
        signal,
        touchpointId: mint.touchpointId,
      })
      // The RPC's email/phone re-check can attach this signal to a
      // pre-existing couple — which may be a Ghost (§9 resurrection).
      // A freshly minted couple is never a Ghost, so skip it there.
      if (!mint.minted) {
        await maybeResurrectGhost({
          supabase,
          venueId,
          coupleId: mint.coupleId,
          signal,
        })
      }
    }
    return {
      ...empty,
      action: mint.minted
        ? 'minted'
        : mint.touchpointInserted
          ? 'attached'
          : 'duplicate',
      touchpoint_id: mint.touchpointId,
      touchpoint_inserted: mint.touchpointInserted,
      couple_minted: mint.minted,
      matched_couple_id: mint.coupleId,
    }
  }

  // Identity-poor → Fragment (aggregate-only; never a half-couple).
  const f = await insertFragment(supabase, venueId, signal)
  return {
    ...empty,
    action: f.inserted ? 'fragment' : 'duplicate',
    fragment_inserted: f.inserted,
  }
}
