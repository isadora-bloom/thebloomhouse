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
 *      webhook handler when eventType === 'invitee.canceled'. Routes
 *      a tour_cancelled NormalizedSignal through `linkSignal` (the
 *      cascade chokepoint). On identity-poor fragment outcomes with a
 *      legacy weddingId anchor available, falls back to the narrow
 *      `tourCancellationFallback` helper so the D9 cohort funnel does
 *      not silently drop cancellations to fragments.
 *
 *   2. sweepPastBookingsForAttendance(supabase, venueId) — daily cron.
 *      Walks tour_booked touchpoints whose occurred_at is more than
 *      `OUTCOME_LAG_HOURS` in the past AND have no terminal outcome
 *      touchpoint (attended / no_show / cancelled). Builds one
 *      attended_derived NormalizedSignal per eligible booking and
 *      ships the batch through `linkSignalBatch`. Idempotent via
 *      `UNIQUE (venue_id, channel, external_id)` where external_id =
 *      "${booking_external}:attended".
 *
 * Phase 1 Batch 2 chokepoint flips (C11 + C12, 2026-05-26):
 *  - Both entry points used to land direct `touchpoints.upsert` writes.
 *    Per PHASE-1-BATCH-2.md §4, those were chokepoint violations — the
 *    Pbatch2-9 guard restructure made them visible. C11 + C12 here are
 *    TRUE flips: the direct writes are removed entirely; cascade calls
 *    are the only path. The narrow Pbatch2-10 fallback for identity-
 *    poor cancellations lives in `calendly-to-signal.ts` and is
 *    invoked from C11 only.
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
import { linkSignal, linkSignalBatch } from '@/lib/spine/cascade'
import {
  calendlyToNormalizedSignal,
  tourCancellationFallback,
} from './calendly-to-signal'
import type { NormalizedSignal } from './sources/types'

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
 * Route an invitee.canceled webhook through the cascade as a
 * tour_cancelled NormalizedSignal. The webhook payload's `payload.email`
 * and `payload.scheduled_event.uri` uniquely identify the booking; the
 * builder uses the scheduled_event's URI tail as the dedup key
 * (`<uri>:cancelled`) for symmetry with how invitee.created recorded
 * the tour_booked.
 *
 * Returns {matched: false} when we cannot find a couple — that means
 * the cancellation is for a tour we never saw (operator's Calendly
 * connected mid-cancel-cycle); silently no-op, don't error.
 *
 * Pbatch2-10 fallback: if `linkSignal` returns a fragment (identity-poor
 * case — phone-only Calendly booking, brain-dump-imported tour, missing
 * inviteeEmail payload) AND a legacy weddingId anchor exists, fall back
 * to `tourCancellationFallback` so the D9 cohort funnel keeps reading
 * a real tour_cancelled touchpoint.
 */
export async function handleCalendlyCancellation(
  supabase: SupabaseClient,
  payload: Record<string, unknown>,
  venueIdHint?: string,
): Promise<CancellationResult> {
  const inviteeEmail =
    typeof payload.email === 'string' ? payload.email.toLowerCase() : null

  if (!inviteeEmail) {
    return { ok: true, matched: false, reason: 'no_invitee_email' }
  }

  // Find the couple via the existing identity surface — primary
  // contact email match. The webhook handler will already have a
  // venueId; we use it as a scope hint to avoid cross-venue look-up.
  // This lookup also gives us the (venueId, legacy weddingId) anchor
  // that linkSignal needs to attach directly without re-scoring.
  let coupleQuery = supabase
    .from('couples')
    .select('id, venue_id, source_wedding_id')
    .eq('primary_contact_email', inviteeEmail)
    .limit(2)
  if (venueIdHint) coupleQuery = coupleQuery.eq('venue_id', venueIdHint)
  const { data: couples, error: coupleErr } = await coupleQuery
  if (coupleErr) {
    return { ok: false, matched: false, reason: `couples_lookup: ${coupleErr.message}` }
  }
  const couple = (couples ?? [])[0] as
    | { id: string; venue_id: string; source_wedding_id: string | null }
    | undefined
  if (!couple) {
    return { ok: true, matched: false, reason: 'no_matching_couple' }
  }

  const venueId = couple.venue_id
  const weddingId = couple.source_wedding_id

  // Build the canonical NormalizedSignal via the Pbatch2-1 builder.
  // The builder's 'invitee_canceled' mode produces a byte-equivalent
  // external_id to the legacy direct upsert at the same external_id
  // pattern (`<scheduled_event_uri>:cancelled`).
  const signal: NormalizedSignal = calendlyToNormalizedSignal({
    event: 'invitee_canceled',
    payload,
    weddingId,
    bookingExternalId: null,
  })

  // C11 flip — route through the cascade chokepoint. linkSignal's
  // legacy_wedding_id fast path attaches the signal to the couple
  // resolved via `couples.source_wedding_id` (the same couple we just
  // looked up by email above).
  let linkResult
  try {
    linkResult = await linkSignal({
      supabase,
      venueId,
      signal,
      source: 'live:calendly_cancel',
    })
  } catch (err) {
    // linkSignal logged + re-threw. Soft-fail with a reason; the webhook
    // handler returns 200 and we don't bubble the throw out of this
    // function (matches the legacy contract).
    const message = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      matched: true,
      coupleId: couple.id,
      reason: `link_signal: ${message}`,
    }
  }

  // Pbatch2-10 fallback path — identity-poor cancellation that landed
  // as a fragment instead of a touchpoint. If we have a legacy
  // weddingId anchor, land the touchpoint directly via the narrow
  // chokepoint-scoped fallback so D9 cohort funnel reads keep working.
  if (
    linkResult.action === 'fragment' &&
    linkResult.matched_couple_id === null &&
    weddingId
  ) {
    try {
      const fb = await tourCancellationFallback({
        supabase,
        venueId,
        weddingId,
        signal,
      })
      if (fb.fired && fb.coupleId) {
        return { ok: true, matched: true, coupleId: fb.coupleId }
      }
      if (!fb.ok) {
        return {
          ok: false,
          matched: false,
          reason: `cancellation_fallback: ${fb.reason ?? 'unknown'}`,
        }
      }
      // fb.ok && !fb.fired — no couple for wedding; fall through to
      // the link-result reporting below.
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        matched: false,
        reason: `cancellation_fallback_throw: ${message}`,
      }
    }
  }

  if (linkResult.matched_couple_id) {
    return { ok: true, matched: true, coupleId: linkResult.matched_couple_id }
  }
  return {
    ok: true,
    matched: false,
    reason: `link_action:${linkResult.action}`,
  }
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
 * couple within ±48h of the booking time, ship a tour_attended signal
 * through the cascade.
 *
 * The 2-hour lag exists so a tour that just ended doesn't immediately
 * get marked attended — gives the cancellation webhook room to land
 * if the couple texted Calendly to cancel an hour after the start time.
 *
 * Returns per-venue counts; the cron should call this once per venue
 * per day. Bounded with a per-run limit so a backfill venue doesn't
 * stall the worker.
 *
 * C12 flip — no per-signal fallback. Attendance inference is volume
 * (every past booking that didn't cancel) and missing a single
 * derived-attended signal is lower-cost than missing a cancellation:
 * the downstream consumer sees the booking as "still pending" rather
 * than vanishing from the funnel entirely. If a booking's couple anchor
 * was lost upstream (so linkSignal lands a fragment), the next sweep
 * pass re-attempts it after the upstream re-link.
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
  // outcome within ±48h of the booking's tour time. If not, queue a
  // tour_attended signal for the cascade batch.
  let cancelledSkipped = 0
  const FORTYEIGHT_HOURS_MS = 48 * 3600_000

  const signals: NormalizedSignal[] = []
  for (const booking of eligible) {
    if (!booking.couple_id) continue
    const raw = booking.raw_payload ?? {}
    const scheduledStart =
      typeof raw.scheduled_start === 'string'
        ? (raw.scheduled_start as string)
        : booking.occurred_at
    const scheduledEventUri =
      typeof raw.scheduled_event_uri === 'string'
        ? (raw.scheduled_event_uri as string)
        : null
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
    // de-dupe via UNIQUE (venue_id, channel, external_id). Passing
    // `booking.external_id ?? booking.id` keeps the builder's
    // `<base>:attended` suffix byte-equivalent to the legacy upsert.
    const bookingExternalId = booking.external_id ?? booking.id

    // Synthesise a payload shape the builder's `attended_derived` mode
    // probes (`scheduled_event.start_time`, `scheduled_event.uri`).
    // We don't have invitee email/name at sweep time — the cascade's
    // legacy_wedding_id-equivalent here is the couple_id we're seeding
    // via the legacy_wedding_id slot indirectly through the booking's
    // raw_payload; linkSignal will resolve the couple via the matcher's
    // recent-couples cache and attach.
    const derivedPayload: Record<string, unknown> = {
      scheduled_event: {
        start_time: scheduledStart,
        uri: scheduledEventUri,
      },
    }

    signals.push(
      calendlyToNormalizedSignal({
        event: 'attended_derived',
        payload: derivedPayload,
        weddingId: null,
        bookingExternalId,
      }),
    )
  }

  let attendedInserted = 0
  if (signals.length > 0) {
    try {
      // C12 flip — route the batch through linkSignalBatch. Judge
      // budget capped at min(signals.length, 100) so a backfill venue
      // with thousands of past tours can't spike Sonnet spend.
      const { results, summary } = await linkSignalBatch({
        supabase,
        venueId,
        signals,
        source: 'cron:calendly_attendance_sweep',
        judgeBudget: Math.min(signals.length, 100),
      })
      // Count anything that actually landed a touchpoint (attached /
      // minted) as "inserted" for the operator-facing return shape.
      // Fragments + duplicates are not counted — they're either the
      // upstream re-link backstop or no-op idempotency hits.
      attendedInserted = results.filter(
        (r) => r.touchpoint_id !== null && !r.duplicate,
      ).length
      // Surface any non-trivial fragment-rate in errors[] so the cron
      // log keeps the honesty signal that the legacy `count: 'exact'`
      // return value used to carry implicitly.
      const fragmentCount = summary.fragment ?? 0
      if (fragmentCount > 0) {
        errors.push(
          `attended_fragmented:${fragmentCount} (no per-signal fallback by design — sweep re-runs)`,
        )
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`attended_link_batch: ${message}`)
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
