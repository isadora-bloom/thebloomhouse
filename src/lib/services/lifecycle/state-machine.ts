// ---------------------------------------------------------------------------
// lifecycle/state-machine.ts — canonical 13-stage state machine (Wave 11).
// ---------------------------------------------------------------------------
//
// Anchor docs (~/.claude memory/):
//   - bloom-constitution.md (Point-Zero / forensic identity reconstruction —
//     the lifecycle backbone is parallel to identity: one canonical truth
//     computed from evidence, not invented at write time)
//   - bloom-wave4-identity-reconstruction.md (mirror pattern: one Sonnet
//     job per couple for identity; here, one Haiku judge per soft
//     transition with deterministic short-circuit for clear evidence)
//   - feedback_deep_fix_vs_bandaid.md (LLM judges soft transitions only;
//     deterministic for clear ones — encoded as transition_kind)
//
// WHAT THIS IS
// ------------
// Pure (read-only-from-DB) evidence-to-stage classifier. Given a
// wedding_id, returns:
//   { stage, evidence, transition_kind, reasoning, confidence_0_100 }
//
// Idempotent: re-running on a stable wedding returns the same stage.
//
// The 13 canonical stages (numerically ordered for "is this forward?"
// reasoning, but a couple can leap stages, e.g. cold inquiry that turns
// into immediate booking, so order is descriptive not enforced):
//
//   pre_touch        unknown couple, not in our system yet (rare; notional)
//   first_touch      first signal landed
//   nurture          back-and-forth, no tour yet
//   tour_scheduled   Calendly booking confirmed
//   tour_completed   tour happened (or no_show classified)
//   proposal_active  quote / pricing sent, in negotiation
//   booked           contract signed, deposit received
//   planning_active  6+ months of vendor coordination
//   day_of           T-7 to T+1 days from event
//   post_event       event happened, awaiting review / feedback
//   long_tail        post-review / anniversary / referral phase
//   lost             terminal: closed without booking
//   cancelled        terminal: booked but cancelled before event
//
// DETERMINISTIC FAST-PATHS (rule fires → stage assigned, transition_kind
// = 'deterministic')
//   - status IN ('lost', 'cancelled')                   → terminal
//   - status = 'completed'                              → see post_event /
//                                                          long_tail / day_of
//   - booked_at NOT NULL OR status = 'booked' AND
//     event_date > now() + 7d                           → booked
//   - event_date in [now()-1d, now()+7d]                → day_of
//   - event_date < now() - 7d AND review NOT present    → post_event
//   - event_date < now() - 7d AND review present        → long_tail
//   - upcoming tour found (tours.scheduled_at > now())  → tour_scheduled
//   - tours.outcome IN ('completed','no_show')          → tour_completed
//   - status = 'proposal_sent'                          → proposal_active
//   - first_touch heuristic: 1 inbound, no responses    → first_touch
//   - 2+ inbound + at least 1 outbound, pre-tour        → nurture
//
// SOFT TRANSITIONS (judge — transition_kind = 'llm_judged')
// These are NOT decided here. computeLifecycleStage RETURNS the current
// best-effort stage; the sweep enqueues a job into
// lifecycle_transition_jobs for the LLM judge when a stuck pattern is
// detected. The judge result lands back as a separate
// applyLifecycleTransition call with transition_kind = 'llm_judged'.
// Examples:
//   - proposal_active, silent N days → judge re-classifies as 'lost' or
//     keeps proposal_active
//   - booked, no planning activity 30d → judge moves to planning_active
//     or holds booked
//   - post_event, no review yet 14d → judge holds post_event or moves
//     to long_tail
//
// SAFETY BIAS
// -----------
// When evidence is ambiguous, return the SAFEST stage (most conservative
// forward progress). E.g. an event-date past with no review → post_event,
// not long_tail. A booked-but-no-planning → booked, not planning_active.
// The soft-judge sweep advances softer cases later.
// ---------------------------------------------------------------------------

import type { SupabaseClient } from '@supabase/supabase-js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LifecycleStage =
  | 'pre_touch'
  | 'first_touch'
  | 'nurture'
  | 'tour_scheduled'
  | 'tour_completed'
  | 'proposal_active'
  | 'booked'
  | 'planning_active'
  | 'day_of'
  | 'post_event'
  | 'long_tail'
  | 'lost'
  | 'cancelled'

export const ALL_LIFECYCLE_STAGES: ReadonlyArray<LifecycleStage> = [
  'pre_touch',
  'first_touch',
  'nurture',
  'tour_scheduled',
  'tour_completed',
  'proposal_active',
  'booked',
  'planning_active',
  'day_of',
  'post_event',
  'long_tail',
  'lost',
  'cancelled',
]

export const TERMINAL_LIFECYCLE_STAGES: ReadonlySet<LifecycleStage> = new Set([
  'lost',
  'cancelled',
])

export type LifecycleTransitionKind =
  | 'deterministic'
  | 'llm_judged'
  | 'operator_override'
  | 'auto_stuck'

export interface ComputedLifecycleStage {
  stage: LifecycleStage
  evidence: Record<string, unknown>
  transition_kind: LifecycleTransitionKind
  reasoning: string
  confidence_0_100: number
  /** True when computation considers this candidate eligible for a
   *  soft-transition judge (stage-stuck pattern). The sweep enqueues
   *  these. */
  soft_judge_candidate: boolean
  /** When soft_judge_candidate is true, the stage we'd ask the judge
   *  about (e.g. proposal_active → lost). */
  candidate_stage?: LifecycleStage
}

export interface ComputeLifecycleStageArgs {
  weddingId: string
  supabase: SupabaseClient
  /** Optional override of "now" for testing / replay. Defaults to new Date(). */
  now?: Date
}

// ---------------------------------------------------------------------------
// Stuck thresholds (drives soft_judge_candidate flag)
// ---------------------------------------------------------------------------
// These are the windows after which the soft-judge gets called. They are
// intentionally generous — better to let a couple cool naturally than
// rush a judge call that flips them to lost prematurely.

export const STUCK_THRESHOLDS = {
  /** proposal_active + this many days silent → ask "lost or still alive?" */
  proposal_silent_days: 14,
  /** booked + this many days no planning activity → ask "planning yet?" */
  booked_no_planning_days: 30,
  /** post_event + this many days no review → ask "still post_event or long_tail?" */
  post_event_no_review_days: 21,
} as const

const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Internal types — rows we read
// ---------------------------------------------------------------------------

interface WeddingRow {
  id: string
  venue_id: string
  status: string | null
  booked_at: string | null
  lost_at: string | null
  cancelled_at: string | null
  wedding_date: string | null
  inquiry_date: string | null
  first_response_at: string | null
  tour_date: string | null
}

interface TourRow {
  id: string
  scheduled_at: string | null
  outcome: string | null
}

interface InteractionAgg {
  inbound: number
  outbound: number
  latest_inbound_at: string | null
  latest_outbound_at: string | null
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the canonical lifecycle stage for one wedding from current
 * evidence. Idempotent: re-running on a stable wedding returns the same
 * answer. Caller (transition.ts) compares to the persisted
 * weddings.lifecycle_stage and only writes a transition when they
 * differ.
 *
 * NEVER throws: any DB error short-circuits to a safest-defensible
 * stage (typically 'first_touch') with confidence = 0 and a 'rule:fallback'
 * evidence entry. Callers may inspect evidence.error to detect this.
 */
export async function computeLifecycleStage(
  args: ComputeLifecycleStageArgs,
): Promise<ComputedLifecycleStage> {
  const { supabase, weddingId } = args
  const now = args.now ?? new Date()
  const nowMs = now.getTime()

  // ------- Read the wedding row -------
  let wedding: WeddingRow | null = null
  try {
    const { data, error } = await supabase
      .from('weddings')
      .select(
        'id, venue_id, status, booked_at, lost_at, cancelled_at, ' +
          'wedding_date, inquiry_date, first_response_at, tour_date',
      )
      .eq('id', weddingId)
      .maybeSingle()
    if (error) {
      return fallback('first_touch', 'wedding fetch error: ' + error.message)
    }
    if (!data) {
      return fallback('pre_touch', 'wedding not found')
    }
    wedding = data as unknown as WeddingRow
  } catch (err) {
    return fallback(
      'first_touch',
      'wedding fetch threw: ' + (err instanceof Error ? err.message : String(err)),
    )
  }

  const evidence: Record<string, unknown> = {
    status: wedding.status,
    booked_at: wedding.booked_at,
    lost_at: wedding.lost_at,
    cancelled_at: wedding.cancelled_at,
    wedding_date: wedding.wedding_date,
    inquiry_date: wedding.inquiry_date,
    first_response_at: wedding.first_response_at,
  }

  // ------- RULE 1: terminal states from legacy status -------
  if (wedding.status === 'lost') {
    return {
      stage: 'lost',
      evidence: { ...evidence, rule: 'status_lost' },
      transition_kind: 'deterministic',
      reasoning: 'weddings.status = lost (legacy terminal)',
      confidence_0_100: 100,
      soft_judge_candidate: false,
    }
  }
  if (wedding.status === 'cancelled') {
    return {
      stage: 'cancelled',
      evidence: { ...evidence, rule: 'status_cancelled' },
      transition_kind: 'deterministic',
      reasoning: 'weddings.status = cancelled (legacy terminal)',
      confidence_0_100: 100,
      soft_judge_candidate: false,
    }
  }

  // ------- RULE 2: event-date driven post-booking stages -------
  // If we have an event date in the past or near future, the
  // event-relative window dominates. day_of [-1d, +7d], post_event
  // (>7d past, no review), long_tail (>7d past, review present).
  const eventMs = parseTs(wedding.wedding_date)
  if (eventMs !== null) {
    const deltaDays = (eventMs - nowMs) / DAY_MS

    if (deltaDays >= -1 && deltaDays <= 7) {
      return {
        stage: 'day_of',
        evidence: {
          ...evidence,
          rule: 'event_within_window',
          delta_days: round1(deltaDays),
        },
        transition_kind: 'deterministic',
        reasoning: 'wedding_date within day-of window (T-7d..T+1d)',
        confidence_0_100: 95,
        soft_judge_candidate: false,
      }
    }

    if (deltaDays < -1) {
      // Event passed. Is there a review?
      const reviewPresent = await reviewExists(supabase, weddingId)
      const daysSinceEvent = -deltaDays

      if (reviewPresent) {
        return {
          stage: 'long_tail',
          evidence: {
            ...evidence,
            rule: 'event_past_with_review',
            days_since_event: round1(daysSinceEvent),
          },
          transition_kind: 'deterministic',
          reasoning: 'event date past with review received',
          confidence_0_100: 90,
          soft_judge_candidate: false,
        }
      }

      // No review yet. Soft-judge candidate after threshold.
      const isStuck =
        daysSinceEvent > STUCK_THRESHOLDS.post_event_no_review_days
      return {
        stage: 'post_event',
        evidence: {
          ...evidence,
          rule: 'event_past_no_review',
          days_since_event: round1(daysSinceEvent),
          stuck_threshold_days: STUCK_THRESHOLDS.post_event_no_review_days,
        },
        transition_kind: 'deterministic',
        reasoning: 'event date past, no review yet',
        confidence_0_100: 80,
        soft_judge_candidate: isStuck,
        candidate_stage: 'long_tail',
      }
    }
  }

  // ------- RULE 3: booked from contract / status -------
  // booked_at set OR status='booked' means contract is signed. If we
  // got past the event-window rule above, we are pre-event (or no
  // event date).
  const bookedAtMs = parseTs(wedding.booked_at)
  if (bookedAtMs !== null || wedding.status === 'booked') {
    // If event date is far in the future + no planning activity,
    // mark as stuck for soft judge to elevate to planning_active.
    const interactions = await aggregateInteractions(supabase, weddingId, {
      since: bookedAtMs ? new Date(bookedAtMs).toISOString() : null,
    })
    const daysSinceBooked =
      bookedAtMs !== null ? (nowMs - bookedAtMs) / DAY_MS : 0
    const planningSilent =
      bookedAtMs !== null &&
      daysSinceBooked > STUCK_THRESHOLDS.booked_no_planning_days &&
      interactions.inbound + interactions.outbound === 0

    return {
      stage: 'booked',
      evidence: {
        ...evidence,
        rule: 'booked_pre_event',
        days_since_booked: round1(daysSinceBooked),
        post_booking_interactions:
          interactions.inbound + interactions.outbound,
      },
      transition_kind: 'deterministic',
      reasoning: 'contract signed (booked_at set OR status=booked)',
      confidence_0_100: 95,
      soft_judge_candidate: planningSilent,
      candidate_stage: 'planning_active',
    }
  }

  // ------- RULE 4: completed legacy status (no event date) -------
  // The 8-status enum has a 'completed' value. If no event_date
  // overrides above, treat as post_event by default. This row is
  // probably stale legacy data; we'd rather it be post_event than
  // misclassified.
  if (wedding.status === 'completed') {
    return {
      stage: 'post_event',
      evidence: { ...evidence, rule: 'status_completed_no_date' },
      transition_kind: 'deterministic',
      reasoning: 'legacy status=completed with no wedding_date',
      confidence_0_100: 60,
      soft_judge_candidate: false,
    }
  }

  // ------- RULE 5: tours -------
  // tour_completed > tour_scheduled. Tour outcome flips priority.
  const tours = await fetchTours(supabase, weddingId)

  const completedTour = tours.find(
    (t) =>
      t.outcome === 'completed' ||
      t.outcome === 'no_show' ||
      t.outcome === 'cancelled',
  )
  const upcomingTour = tours.find((t) => {
    const ms = parseTs(t.scheduled_at)
    return (
      (t.outcome === null || t.outcome === 'pending') &&
      ms !== null &&
      ms > nowMs
    )
  })

  // proposal_active: legacy status=proposal_sent OR explicit signal in
  // future (Wave 11 doesn't have direct evidence of a proposal yet
  // beyond the legacy enum; future waves wire HoneyBook proposal events
  // into this rule).
  if (wedding.status === 'proposal_sent') {
    // Detect proposal-stuck: how long has it been silent?
    const interactions = await aggregateInteractions(supabase, weddingId, {
      since: null,
    })
    const lastSignalMs = mostRecentMs([
      parseTs(interactions.latest_inbound_at),
      parseTs(interactions.latest_outbound_at),
    ])
    const silentDays =
      lastSignalMs === null ? null : (nowMs - lastSignalMs) / DAY_MS
    const isStuck =
      silentDays !== null && silentDays > STUCK_THRESHOLDS.proposal_silent_days

    return {
      stage: 'proposal_active',
      evidence: {
        ...evidence,
        rule: 'status_proposal_sent',
        silent_days: silentDays !== null ? round1(silentDays) : null,
        stuck_threshold_days: STUCK_THRESHOLDS.proposal_silent_days,
      },
      transition_kind: 'deterministic',
      reasoning: 'weddings.status = proposal_sent',
      confidence_0_100: 90,
      soft_judge_candidate: isStuck,
      candidate_stage: 'lost',
    }
  }

  if (completedTour) {
    return {
      stage: 'tour_completed',
      evidence: {
        ...evidence,
        rule: 'tour_outcome_terminal',
        tour_id: completedTour.id,
        tour_outcome: completedTour.outcome,
      },
      transition_kind: 'deterministic',
      reasoning: 'tour outcome classified (completed/no_show/cancelled)',
      confidence_0_100: 90,
      soft_judge_candidate: false,
    }
  }

  if (upcomingTour) {
    return {
      stage: 'tour_scheduled',
      evidence: {
        ...evidence,
        rule: 'tour_upcoming',
        tour_id: upcomingTour.id,
        tour_scheduled_at: upcomingTour.scheduled_at,
      },
      transition_kind: 'deterministic',
      reasoning: 'upcoming tour scheduled in calendar',
      confidence_0_100: 95,
      soft_judge_candidate: false,
    }
  }

  // ------- RULE 6: tour_scheduled / tour_completed via legacy status -------
  if (wedding.status === 'tour_scheduled') {
    return {
      stage: 'tour_scheduled',
      evidence: { ...evidence, rule: 'status_tour_scheduled' },
      transition_kind: 'deterministic',
      reasoning: 'weddings.status = tour_scheduled',
      confidence_0_100: 80,
      soft_judge_candidate: false,
    }
  }
  if (wedding.status === 'tour_completed') {
    return {
      stage: 'tour_completed',
      evidence: { ...evidence, rule: 'status_tour_completed' },
      transition_kind: 'deterministic',
      reasoning: 'weddings.status = tour_completed',
      confidence_0_100: 80,
      soft_judge_candidate: false,
    }
  }

  // ------- RULE 7: inquiry stage — first_touch vs nurture -------
  const interactions = await aggregateInteractions(supabase, weddingId, {
    since: null,
  })

  if (interactions.inbound === 0 && interactions.outbound === 0) {
    // Wedding row exists but no interactions yet — pre_touch is the
    // notional stage. In practice an inquiry that creates a wedding
    // row usually carries an interaction, so this is rare.
    return {
      stage: 'pre_touch',
      evidence: {
        ...evidence,
        rule: 'no_interactions',
        inbound: 0,
        outbound: 0,
      },
      transition_kind: 'deterministic',
      reasoning: 'wedding row exists but no interactions recorded',
      confidence_0_100: 70,
      soft_judge_candidate: false,
    }
  }

  // nurture: 2+ inbound AND >= 1 outbound, both directions present
  if (interactions.inbound >= 2 && interactions.outbound >= 1) {
    return {
      stage: 'nurture',
      evidence: {
        ...evidence,
        rule: 'two_way_thread_pre_tour',
        inbound: interactions.inbound,
        outbound: interactions.outbound,
      },
      transition_kind: 'deterministic',
      reasoning:
        'two-way thread established (2+ inbound + 1+ outbound), no tour',
      confidence_0_100: 80,
      soft_judge_candidate: false,
    }
  }

  // first_touch fallback
  return {
    stage: 'first_touch',
    evidence: {
      ...evidence,
      rule: 'first_touch_default',
      inbound: interactions.inbound,
      outbound: interactions.outbound,
    },
    transition_kind: 'deterministic',
    reasoning: 'first signal landed, no nurture pattern yet',
    confidence_0_100: 70,
    soft_judge_candidate: false,
  }
}

// ---------------------------------------------------------------------------
// Helpers — DB reads
// ---------------------------------------------------------------------------

async function fetchTours(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<TourRow[]> {
  try {
    const { data, error } = await supabase
      .from('tours')
      .select('id, scheduled_at, outcome')
      .eq('wedding_id', weddingId)
      .order('scheduled_at', { ascending: false })
      .limit(20)
    if (error) return []
    return (data ?? []) as TourRow[]
  } catch {
    return []
  }
}

async function reviewExists(
  supabase: SupabaseClient,
  weddingId: string,
): Promise<boolean> {
  // Two paths: a reviews table keyed on wedding_id, or a
  // wedding_reviews fk pattern. We probe both gently — if neither
  // exists, we conservatively return false. The schema today carries
  // reviews tied via people / venue in places; the safest read is the
  // reviews table with a wedding_id column.
  try {
    const { count, error } = await supabase
      .from('reviews')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', weddingId)
      .limit(1)
    if (!error && (count ?? 0) > 0) return true
  } catch {
    // table may not exist or column may differ — ignore
  }
  return false
}

async function aggregateInteractions(
  supabase: SupabaseClient,
  weddingId: string,
  opts: { since: string | null },
): Promise<InteractionAgg> {
  const empty: InteractionAgg = {
    inbound: 0,
    outbound: 0,
    latest_inbound_at: null,
    latest_outbound_at: null,
  }
  try {
    let query = supabase
      .from('interactions')
      .select('direction, timestamp')
      .eq('wedding_id', weddingId)
      .order('timestamp', { ascending: false })
      .limit(200)
    if (opts.since) query = query.gte('timestamp', opts.since)
    const { data, error } = await query
    if (error || !data) return empty

    let inbound = 0
    let outbound = 0
    let latestIn: string | null = null
    let latestOut: string | null = null
    for (const r of data as Array<{ direction: string | null; timestamp: string | null }>) {
      if (r.direction === 'inbound') {
        inbound++
        if (!latestIn && r.timestamp) latestIn = r.timestamp
      } else if (r.direction === 'outbound') {
        outbound++
        if (!latestOut && r.timestamp) latestOut = r.timestamp
      }
    }
    return {
      inbound,
      outbound,
      latest_inbound_at: latestIn,
      latest_outbound_at: latestOut,
    }
  } catch {
    return empty
  }
}

// ---------------------------------------------------------------------------
// Helpers — math
// ---------------------------------------------------------------------------

function parseTs(s: string | null): number | null {
  if (!s) return null
  const n = Date.parse(s)
  return Number.isFinite(n) ? n : null
}

function mostRecentMs(values: Array<number | null>): number | null {
  let best: number | null = null
  for (const v of values) {
    if (v !== null && (best === null || v > best)) best = v
  }
  return best
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function fallback(
  stage: LifecycleStage,
  reason: string,
): ComputedLifecycleStage {
  return {
    stage,
    evidence: { rule: 'fallback', error: reason },
    transition_kind: 'deterministic',
    reasoning: reason,
    confidence_0_100: 0,
    soft_judge_candidate: false,
  }
}
