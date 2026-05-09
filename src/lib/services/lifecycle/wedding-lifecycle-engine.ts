// ---------------------------------------------------------------------------
// lifecycle/wedding-lifecycle-engine.ts -- pure state machine for weddings.
// ---------------------------------------------------------------------------
//
// One source of truth for legal wedding-lifecycle transitions. The engine is
// deliberately I/O-free so unit tests can assert every (state, signal)
// combination without mocking Supabase, and so callers in different code
// paths (live email pipeline, scheduling-tool branch, coordinator UI,
// HoneyBook webhook, calendly hook, deposit-paid handler, backfill script)
// can re-use the exact same legality table.
//
// Why this exists
// ---------------
// Pre-engine, status mutations were scattered across:
//   - lib/services/email/pipeline.ts (line ~1553, ~2219, ~2448)
//   - lib/services/heat-mapping.ts   (line ~1390 booked, ~1464 lost)
//   - lib/services/attribution/signal-inference.ts (line ~575)
//   - lib/services/identity/merge-people.ts (line ~114)
//   - lib/services/crm-import/* (per-source status derivers)
//   - app/api/agent/confirm-booking/route.ts (line ~115)
//   - app/(platform)/agent/pipeline/page.tsx (drag-drop, line ~573)
//   - app/(platform)/portal/weddings/page.tsx (manual mark-as-booked)
//
// Each site invented its own ordering rules. The 2026-05-08 Naina Davidar
// regression (WeddingPro "decided to close the conversation" produced a
// chirpy auto-reply) surfaced the cost: nothing knew that "lead_declined"
// or "silent_close" should advance a wedding to lost. The engine fixes
// that gap by making the legality table data-driven, not code-scattered.
//
// Hard rules
// ----------
//   - Pure function. No I/O. No side effects. No Supabase imports.
//   - Returns null when the (from, signal) pair is illegal -- the caller
//     is expected to log a wedding_lifecycle_violation event so drift is
//     visible to coordinators rather than silently swallowed.
//   - Terminal states (lost / cancelled / completed) cannot be transitioned
//     out of by any signal except an explicit coordinator override path
//     (which lives outside this engine on purpose -- a coordinator
//     reopening a "lost" deal is a manual, audited action, not an AI
//     signal we trust).
//   - The "hot lead reverts to fresh inquiry on tour_cancelled" rule is
//     intentional: per Isadora 2026-05-08, a couple who books then
//     cancels a tour without rebooking is functionally back at square
//     one, and she prefers the inbox + intel UI to treat them that way
//     rather than leave them parked in tour_scheduled forever.
// ---------------------------------------------------------------------------

export type WeddingStatus =
  | 'inquiry'
  | 'tour_scheduled'
  | 'tour_completed'
  | 'proposal_sent'
  | 'booked'
  | 'completed'
  | 'lost'
  | 'cancelled'

export type LifecycleSignal =
  | 'inquiry_received'
  | 'tour_requested'
  | 'tour_scheduled'
  | 'tour_cancelled'
  | 'tour_completed'
  | 'proposal_sent'
  | 'contract_signed'
  | 'deposit_paid'
  | 'lead_declined'
  | 'going_with_other'
  | 'silent_close'
  | 'date_changed'
  | 'wedding_held'
  | 'wedding_cancelled'

export interface LifecycleTransition {
  from: WeddingStatus
  to: WeddingStatus
  reason: string
  appliedAt: string
}

export interface LifecycleDecision {
  to: WeddingStatus
  reason: string
}

// Terminal states the engine refuses to leave on its own. A coordinator
// reopening a lost deal is an explicit out-of-band action, not a
// signal-driven transition.
const TERMINAL_STATES: ReadonlySet<WeddingStatus> = new Set([
  'lost',
  'cancelled',
  'completed',
])

// Pre-booking states share most of the loss/booking logic. Capturing them
// once keeps the legality table compact and matches how the rest of the
// codebase already groups them (heat-mapping, follow-up sequences,
// signal-inference all special-case this exact set).
const PRE_BOOKING_STATES: ReadonlySet<WeddingStatus> = new Set([
  'inquiry',
  'tour_scheduled',
  'tour_completed',
  'proposal_sent',
])

// Forward-progression rank used by tour_scheduled / tour_completed /
// proposal_sent signals. Mirrors the STATUS_RANK map in
// lib/services/email/pipeline.ts (line ~2436) -- if you change one, change
// the other or unify them through this constant.
const FORWARD_RANK: Record<WeddingStatus, number> = {
  inquiry: 0,
  tour_scheduled: 1,
  tour_completed: 2,
  proposal_sent: 3,
  booked: 4,
  completed: 5,
  lost: 99,
  cancelled: 99,
}

/**
 * Compute the next status for a (current, signal) pair.
 *
 * Returns null when the transition is illegal. Examples of illegal pairs
 * the engine rejects on purpose:
 *   - lost + contract_signed       (phantom revival, surface as drift)
 *   - cancelled + tour_completed   (state of the wedding has been zeroed)
 *   - completed + lead_declined    (event already happened, declines
 *                                   are nonsense)
 *   - booked + going_with_other    (couple already chose us; if real,
 *                                   coordinator has manual cancellation
 *                                   path; if false-positive AI signal,
 *                                   we want it visible not silent)
 */
export function nextStatus(
  current: WeddingStatus,
  signal: LifecycleSignal,
): LifecycleDecision | null {
  // ---------------------------------------------------------------------
  // Loss signals (lead_declined / going_with_other / silent_close).
  // ---------------------------------------------------------------------
  // Any pre-booking state moves to 'lost'. Booked / completed reject
  // these signals -- a couple who is already booked saying they're
  // "going with another venue" is either a mistake, a separate event,
  // or coordinator-action territory. Surface as drift, don't downgrade.
  if (signal === 'lead_declined' || signal === 'going_with_other' || signal === 'silent_close') {
    if (PRE_BOOKING_STATES.has(current)) {
      return { to: 'lost', reason: signalToLossReason(signal) }
    }
    // Already lost / cancelled / completed: no-op (still illegal so the
    // caller sees it in violations, but we collapse the no-op case
    // below to a null-with-context return so it doesn't pollute alerts).
    return null
  }

  // ---------------------------------------------------------------------
  // Booking signals (contract_signed / deposit_paid).
  // ---------------------------------------------------------------------
  // Any pre-booking state advances to booked. Already-booked / completed
  // is a no-op (not a violation). Lost + contract_signed is the
  // interesting case: it's almost always a legitimate revival (couple
  // came back), but we refuse to silently flip it because the dashboard
  // counts and intel narratives have been built on the lost state. Force
  // the coordinator-action path.
  if (signal === 'contract_signed' || signal === 'deposit_paid') {
    if (PRE_BOOKING_STATES.has(current)) {
      return {
        to: 'booked',
        reason:
          signal === 'contract_signed'
            ? 'contract signed'
            : 'deposit paid',
      }
    }
    return null
  }

  // ---------------------------------------------------------------------
  // tour_scheduled signal -- couple booked a tour.
  // ---------------------------------------------------------------------
  // From inquiry / tour_completed (post-tour rebook) / proposal_sent
  // (proposal-stage retour) advance to tour_scheduled. From
  // tour_scheduled itself it's a no-op. From booked / completed / lost /
  // cancelled it's illegal (a tour booked AFTER booking is a
  // walkthrough, not a tour, and should fire as final_walkthrough on a
  // separate path).
  if (signal === 'tour_scheduled') {
    if (current === 'tour_scheduled') return null
    if (PRE_BOOKING_STATES.has(current)) {
      return { to: 'tour_scheduled', reason: 'tour scheduled' }
    }
    return null
  }

  // ---------------------------------------------------------------------
  // tour_completed signal -- post-tour follow-up language detected.
  // ---------------------------------------------------------------------
  // Forward-only. inquiry / tour_scheduled advance to tour_completed.
  // proposal_sent stays at proposal_sent (we don't downgrade). Anything
  // terminal is illegal.
  if (signal === 'tour_completed') {
    if (current === 'inquiry' || current === 'tour_scheduled') {
      return { to: 'tour_completed', reason: 'tour completed' }
    }
    if (current === 'tour_completed' || current === 'proposal_sent') return null
    return null
  }

  // ---------------------------------------------------------------------
  // proposal_sent signal.
  // ---------------------------------------------------------------------
  // Only forward. Reject from booked / lost / cancelled / completed.
  if (signal === 'proposal_sent') {
    if (PRE_BOOKING_STATES.has(current)) {
      const currentRank = FORWARD_RANK[current]
      const targetRank = FORWARD_RANK['proposal_sent']
      if (targetRank > currentRank) {
        return { to: 'proposal_sent', reason: 'proposal sent' }
      }
      return null
    }
    return null
  }

  // ---------------------------------------------------------------------
  // tour_cancelled signal.
  // ---------------------------------------------------------------------
  // Per Isadora 2026-05-08: a hot lead whose tour gets cancelled (and
  // not rebooked) reverts to a fresh 'inquiry'. The tour-cancellation
  // is implicitly a re-engagement opportunity rather than a loss; if
  // the couple goes silent after, the heat-decay / silent_close path
  // will eventually mark them lost.
  if (signal === 'tour_cancelled') {
    if (PRE_BOOKING_STATES.has(current)) {
      if (current === 'inquiry') return null // already there
      return { to: 'inquiry', reason: 'tour cancelled, reverting to inquiry' }
    }
    return null
  }

  // ---------------------------------------------------------------------
  // tour_requested signal -- platform / classifier said "they want a tour".
  // ---------------------------------------------------------------------
  // Without a real scheduled date this is a heat signal, not a state
  // transition. Stay where we are. Engine returns null on purpose -- no
  // violation, no transition.
  if (signal === 'tour_requested') {
    return null
  }

  // ---------------------------------------------------------------------
  // inquiry_received signal -- the row was just born or reopened.
  // ---------------------------------------------------------------------
  // No-op when already in inquiry. Transitions out of terminal states are
  // handled by the explicit reopen path on the wedding detail page; the
  // engine itself refuses.
  if (signal === 'inquiry_received') {
    return null
  }

  // ---------------------------------------------------------------------
  // Post-booking lifecycle (date_changed / wedding_held / wedding_cancelled).
  // ---------------------------------------------------------------------
  if (signal === 'wedding_cancelled') {
    if (current === 'booked') {
      return { to: 'cancelled', reason: 'wedding cancelled' }
    }
    return null
  }

  if (signal === 'wedding_held') {
    if (current === 'booked') {
      return { to: 'completed', reason: 'wedding held' }
    }
    return null
  }

  // date_changed is informational, not a status transition. Heat-mapping
  // + intel attribution care about it; the lifecycle does not.
  if (signal === 'date_changed') {
    return null
  }

  // Defensive fallthrough -- shouldn't be reachable because the type
  // system enumerates LifecycleSignal exhaustively, but TypeScript can't
  // prove it without a never-check, and runtime callers might pass a
  // string-cast value during a refactor.
  return null
}

function signalToLossReason(
  signal: 'lead_declined' | 'going_with_other' | 'silent_close',
): string {
  switch (signal) {
    case 'lead_declined':
      return 'lead declined explicitly'
    case 'going_with_other':
      return 'lead chose another venue'
    case 'silent_close':
      return 'platform-driven close (no further contact)'
  }
}

/**
 * True when `from` is a terminal state the engine refuses to transition
 * out of. Exposed so callers can short-circuit before invoking
 * nextStatus -- e.g. the auto-draft gate skips replying entirely when
 * the wedding is in a terminal state.
 */
export function isTerminalStatus(status: WeddingStatus | string | null): boolean {
  if (!status) return false
  return TERMINAL_STATES.has(status as WeddingStatus)
}

/**
 * True when `signal` indicates the lead is gone. Used by the auto-draft
 * gate at the per-message level: even if the wedding row hasn't yet
 * transitioned to 'lost' (the detector + transition writer are
 * eventually-consistent), a fresh loss signal on the most recent inbound
 * is enough to suppress an outbound draft.
 */
export function isLossSignal(signal: LifecycleSignal | string | null | undefined): boolean {
  return signal === 'lead_declined' || signal === 'going_with_other' || signal === 'silent_close'
}
