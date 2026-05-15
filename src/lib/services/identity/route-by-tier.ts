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
 *   below_threshold  → INSERT fragment (no couple link)
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

export type TierRoutingAction =
  | 'attached'
  | 'candidate_medium'
  | 'candidate_low'
  | 'fragment'
  | 'duplicate'

export interface TierRoutingResult {
  action: TierRoutingAction
  touchpoint_id: string | null
  touchpoint_inserted: boolean
  fragment_inserted: boolean
  candidate_match_queued: boolean
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

  // below_threshold → fragment
  const f = await insertFragment(supabase, venueId, signal)
  return {
    ...empty,
    action: f.inserted ? 'fragment' : 'duplicate',
    fragment_inserted: f.inserted,
  }
}
