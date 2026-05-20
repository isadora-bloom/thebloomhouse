/**
 * Calendly outcome classifier — D9 gap fix.
 *
 * D9 (2026-05-19) flagged that `tour_attended` / `tour_no_show` /
 * `tour_cancelled` touchpoints almost never fire. Cohort funnels read
 * empty for the Toured stage; D9's weather × no-show join has nothing
 * to evaluate; D3 attribution's last-touch is starved.
 *
 * Calendly's own API exposes `invitee.canceled` events but has NO
 * "attended" event — Calendly doesn't know if the tour actually
 * happened. The doctrine: cancellations are deterministic (webhook
 * fires), attendance is assumed (past-scheduled-time + no cancellation
 * = attended). Operator overrides remain a separate surface.
 *
 * Two entry points:
 *
 *   1. handleCalendlyCancellation(supabase, payload) — called from the
 *      webhook handler when eventType === 'invitee.canceled'. Inserts a
 *      tour_cancelled touchpoint scoped to the existing wedding (or no-
 *      ops when the wedding cannot be found — cancelled tours we never
 *      saw are not couples we know).
 *
 *   2. sweepPastBookingsForAttendance(supabase, venueId) — daily cron.
 *      Walks tour_booked touchpoints whose occurred_at is more than
 *      `OUTCOME_LAG_HOURS` in the past AND have no terminal outcome
 *      touchpoint (attended / no_show / cancelled). Inserts
 *      tour_attended for each one. Idempotent via UNIQUE (venue_id,
 *      channel, external_id) where external_id = "${booking_id}:attended".
 *
 * Doctrine notes:
 *  - We never default to tour_no_show. Most booked tours actually happen.
 *    No-show is a coordinator-marked event (future operator surface) that
 *    rewrites an existing tour_attended via merge logic.
 *  - tour_cancelled fires only when Calendly's invitee.canceled webhook
 *    fires before scheduled_at OR when the cancellation is recorded
 *    explicitly through the Calendly API.
 *  - Operator-trust-but-verify: if the operator's Calendly is silent for
 *    weeks (auth lapsed), the sweep will mark every booked past tour as
 *    attended — that's the doctrinally right answer until the operator
 *    re-connects.
 *  - Multi-venue safe. No Rixey-specific clauses.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

const OUTCOME_LAG_HOURS = 2
const OUTCOME_LAG_MS = OUTCOME_LAG_HOURS * 3600_000

export interface CancellationResult {
  ok: boolean
  matched: boolean
  reason?: string
  /** When matched=true, the spine couple id whose ribbon now carries
   *  the tour_cancelled touchpoint. */
  coupleId?: string
}

export interface AttendanceSweepResult {
  venueId: string
  bookingsScanned: number
  attendedInserted: number
  cancelledSkipped: number
  errors: string[]
  latencyMs: number
}

// ---------------------------------------------------------------------------
// 1. Cancellation webhook handler
// ---------------------------------------------------------------------------

/**
 * Insert a tour_cancelled touchpoint for an invitee.canceled webhook.
 * The webhook payload's `payload.email` and `payload.scheduled_event.uri`
 * uniquely identify the booking; we use the scheduled_event's URI's
 * tail as the booking_id for dedup symmetry with how invitee.created
 * recorded the tour_booked.
 *
 * Returns {matched: false} when we cannot find a couple — that means
 * the cancellation is for a tour we never saw (operator's Calendly
 * connected mid-cancel-cycle); silently no-op, don't error.
 */
export async function handleCalendlyCancellation(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  venueIdHint?: string,
): Promise<CancellationResult> {
  const inviteeEmail =
    typeof payload.email === 'string' ? payload.email.toLowerCase() : null
  const scheduledEvent = payload.scheduled_event as
    | Record<string, unknown>
    | undefined
  const scheduledEventUri =
    typeof scheduledEvent?.uri === 'string' ? scheduledEvent.uri : null
  const scheduledStart =
    typeof scheduledEvent?.start_time === 'string'
      ? scheduledEvent.start_time
      : null
  const cancelReason = (() => {
    const cancellation = payload.cancellation as
      | Record<string, unknown>
      | undefined
    if (!cancellation) return null
    const reason = cancellation.reason
    return typeof reason === 'string' ? reason : null
  })()

  if (!inviteeEmail) {
    return { ok: true, matched: false, reason: 'no_invitee_email' }
  }

  // Find the couple via the existing identity surface — primary
  // contact email match. The webhook handler will already have a
  // venueId; we use it as a scope hint to avoid cross-venue look-up.
  let coupleQuery = supabase
    .from('couples')
    .select('id, venue_id')
    .eq('primary_contact_email', inviteeEmail)
    .limit(2)
  if (venueIdHint) coupleQuery = coupleQuery.eq('venue_id', venueIdHint)
  const { data: couples, error: coupleErr } = await coupleQuery
  if (coupleErr) {
    return { ok: false, matched: false, reason: `couples_lookup: ${coupleErr.message}` }
  }
  const couple = (couples ?? [])[0] as { id: string; venue_id: string } | undefined
  if (!couple) {
    return { ok: true, matched: false, reason: 'no_matching_couple' }
  }

  // Build the dedup external_id off the scheduled_event uri so a re-
  // delivered webhook upserts cleanly.
  const externalId = scheduledEventUri
    ? `${scheduledEventUri}:cancelled`
    : `${inviteeEmail}:${scheduledStart ?? 'unknown'}:cancelled`

  const { error: insertErr } = await supabase
    .from('touchpoints')
    .upsert(
      {
        venue_id: couple.venue_id,
        couple_id: couple.id,
        channel: 'calendly',
        action_type: 'tour_cancelled',
        occurred_at: new Date().toISOString(),
        signal_tier: 'high',
        external_id: externalId,
        raw_payload: {
          direction: 'inbound',
          scheduled_event_uri: scheduledEventUri,
          scheduled_start: scheduledStart,
          cancel_reason: cancelReason,
        },
      },
      { onConflict: 'venue_id,channel,external_id', ignoreDuplicates: true },
    )
  if (insertErr) {
    return {
      ok: false,
      matched: true,
      coupleId: couple.id,
      reason: `touchpoint_insert: ${insertErr.message}`,
    }
  }
  return { ok: true, matched: true, coupleId: couple.id }
}

// ---------------------------------------------------------------------------
// 2. Attendance sweep (daily cron)
// ---------------------------------------------------------------------------

interface BookingRow {
  id: string
  couple_id: string | null
  occurred_at: string
  external_id: string | null
  raw_payload: Record<string, unknown> | null
}

interface OutcomeRow {
  couple_id: string | null
  action_type: string
  occurred_at: string
}

/**
 * Walk tour_booked touchpoints on the calendly channel whose
 * occurred_at is older than OUTCOME_LAG_HOURS hours, and for any that
 * lack a terminal outcome (attended / no_show / cancelled) for the same
 * couple within ±48h of the booking time, insert tour_attended.
 *
 * The 2-hour lag exists so a tour that just ended doesn't immediately
 * get marked attended — gives the cancellation webhook room to land
 * if the couple texted Calendly to cancel an hour after the start time.
 *
 * Returns per-venue counts; the cron should call this once per venue
 * per day. Bounded with a per-run limit so a backfill venue doesn't
 * stall the worker.
 */
export async function sweepPastBookingsForAttendance(
  supabase: SupabaseClient,
  venueId: string,
  options: { bookingLimit?: number } = {},
): Promise<AttendanceSweepResult> {
  const start = Date.now()
  const limit = options.bookingLimit ?? 500
  const errors: string[] = []

  const cutoff = new Date(Date.now() - OUTCOME_LAG_MS).toISOString()

  // Pull tour_booked rows that are past the lag window. occurred_at
  // is the booking timestamp, not the scheduled tour time — but the
  // webhook records scheduled_start in raw_payload, so we filter on
  // that when present.
  const { data: bookings, error: bookErr } = await supabase
    .from('touchpoints')
    .select('id, couple_id, occurred_at, external_id, raw_payload')
    .eq('venue_id', venueId)
    .eq('channel', 'calendly')
    .eq('action_type', 'tour_booked')
    .order('occurred_at', { ascending: true })
    .limit(limit)
  if (bookErr) {
    errors.push(`bookings_query: ${bookErr.message}`)
    return {
      venueId,
      bookingsScanned: 0,
      attendedInserted: 0,
      cancelledSkipped: 0,
      errors,
      latencyMs: Date.now() - start,
    }
  }

  // Filter bookings whose tour time (scheduled_start when present,
  // else occurred_at) is older than the lag cutoff.
  const eligible = ((bookings ?? []) as BookingRow[]).filter((b) => {
    const raw = b.raw_payload ?? {}
    const scheduledStart =
      typeof raw.scheduled_start === 'string'
        ? (raw.scheduled_start as string)
        : null
    const tourTime = scheduledStart ?? b.occurred_at
    return Date.parse(tourTime) <= Date.parse(cutoff)
  })

  if (eligible.length === 0) {
    return {
      venueId,
      bookingsScanned: bookings?.length ?? 0,
      attendedInserted: 0,
      cancelledSkipped: 0,
      errors,
      latencyMs: Date.now() - start,
    }
  }

  // Pull existing outcome rows for the couples we're about to
  // evaluate. One bulk read; cheap because outcomes are per-couple.
  const coupleIds = Array.from(
    new Set(
      eligible
        .map((b) => b.couple_id)
        .filter((v): v is string => Boolean(v)),
    ),
  )
  const { data: outcomes, error: outcomeErr } = await supabase
    .from('touchpoints')
    .select('couple_id, action_type, occurred_at')
    .eq('venue_id', venueId)
    .eq('channel', 'calendly')
    .in('couple_id', coupleIds)
    .in('action_type', ['tour_attended', 'tour_no_show', 'tour_cancelled'])
  if (outcomeErr) {
    errors.push(`outcomes_query: ${outcomeErr.message}`)
  }
  const outcomesByCouple = new Map<string, OutcomeRow[]>()
  for (const o of (outcomes ?? []) as OutcomeRow[]) {
    if (!o.couple_id) continue
    const list = outcomesByCouple.get(o.couple_id)
    if (list) list.push(o)
    else outcomesByCouple.set(o.couple_id, [o])
  }

  // For each eligible booking, check whether its couple has a terminal
  // outcome within ±48h of the booking's tour time. If not, insert
  // tour_attended.
  let attendedInserted = 0
  let cancelledSkipped = 0
  const FORTYEIGHT_HOURS_MS = 48 * 3600_000

  const inserts: Record<string, unknown>[] = []
  for (const booking of eligible) {
    if (!booking.couple_id) continue
    const raw = booking.raw_payload ?? {}
    const scheduledStart =
      typeof raw.scheduled_start === 'string'
        ? (raw.scheduled_start as string)
        : booking.occurred_at
    const tourMs = Date.parse(scheduledStart)

    const couple_outcomes = outcomesByCouple.get(booking.couple_id) ?? []
    const hasTerminal = couple_outcomes.some((o) => {
      const oMs = Date.parse(o.occurred_at)
      if (!Number.isFinite(oMs)) return false
      return Math.abs(oMs - tourMs) <= FORTYEIGHT_HOURS_MS
    })
    if (hasTerminal) {
      // If the existing terminal is a cancellation, that's the truth;
      // otherwise (attended or no_show) the operator has already
      // adjudicated — leave it alone.
      if (
        couple_outcomes.some(
          (o) => o.action_type === 'tour_cancelled',
        )
      ) {
        cancelledSkipped += 1
      }
      continue
    }

    // External id ties this attendance row to its booking so reruns
    // de-dupe via UNIQUE (venue_id, channel, external_id).
    const externalId = booking.external_id
      ? `${booking.external_id}:attended`
      : `${booking.id}:attended`
    inserts.push({
      venue_id: venueId,
      couple_id: booking.couple_id,
      channel: 'calendly',
      action_type: 'tour_attended',
      occurred_at: scheduledStart,
      signal_tier: 'high',
      external_id: externalId,
      raw_payload: {
        direction: 'inbound',
        derived_from_booking: booking.id,
        rule: 'past_scheduled_time_without_cancellation',
      },
    })
  }

  if (inserts.length > 0) {
    const { error: insertErr, count } = await supabase
      .from('touchpoints')
      .upsert(inserts, {
        onConflict: 'venue_id,channel,external_id',
        ignoreDuplicates: true,
        count: 'exact',
      })
    if (insertErr) {
      errors.push(`attended_insert: ${insertErr.message}`)
    } else {
      attendedInserted = count ?? 0
    }
  }

  return {
    venueId,
    bookingsScanned: bookings?.length ?? 0,
    attendedInserted,
    cancelledSkipped,
    errors,
    latencyMs: Date.now() - start,
  }
}
