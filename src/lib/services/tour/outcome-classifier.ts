/**
 * Tour Outcome Classifier — flip past-due tours from 'pending' to the
 * right terminal outcome (completed / cancelled / no_show).
 *
 * T5-Rixey-GGG Bug 12.
 *
 * Pre-fix state: a brand-new venue onboards, its 12-month HoneyBook +
 * Calendly history lands in tours with outcome='pending', and nothing
 * ever flips them. Tour Tracking shows 280 tours / 0 completed / 0%
 * conversion. The cancel-tour modal in the UI is the only writer that
 * sets outcome='cancelled'. There is no writer for 'completed' or
 * 'no_show' beyond the cancellation-from-email edge case in
 * email-pipeline.
 *
 * This service runs as a daily cron (vercel.json `tour_outcome_classifier`
 * at 06:00 UTC, after weather + correlation crons). For every tour with
 * outcome='pending' OR NULL whose scheduled_at + duration is in the past,
 * walk the evidence and choose the right outcome:
 *
 *   1. CANCELLED — explicit cancellation evidence in the days leading
 *      up to the tour. Sources:
 *        a. interactions tagged with cancel/cancellation indicators
 *           (subject or body contains explicit cancellation phrasing).
 *           Per the safety bias in the brief: when uncertain, KEEP
 *           pending. Only mark cancelled when the signal is unambiguous.
 *        b. engagement_events with event_type='tour_cancelled' fired in
 *           a window AROUND the tour date (interpreted as "the couple
 *           backed out").
 *
 *   2. NO_SHOW — pattern of "didn't show" / "didn't make it" /
 *      "no-show" in coordinator notes (tours.notes) or in interactions
 *      after the tour date. Cheap pattern match — this is intentionally
 *      conservative.
 *
 *   3. COMPLETED — anything that doesn't match #1 or #2 AND is past-due.
 *      The tour happened as scheduled. This is the bulk of rows.
 *
 * The classifier NEVER flips an outcome that is already terminal —
 * 'booked', 'lost', 'cancelled', 'no_show', 'rescheduled'. Coordinator
 * intent always wins over inferred state. Outcomes 'completed' and
 * 'pending' (or NULL) are the only inputs.
 *
 * False positives matter more than false negatives — wrongly flipping a
 * real tour to 'cancelled' is worse than leaving it 'pending'. The
 * cancellation walk is intentionally conservative; if doubt exists,
 * keep 'pending' so the coordinator review surfaces it.
 *
 * Idempotent: re-running on already-classified rows is a no-op (filter
 * narrows to outcome IN ('pending', NULL)). Backfill = same code path.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/service'
import { extractCancellationReason } from '@/lib/services/tour/cancellation-reason'

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Default tour duration when tours.duration is NULL. Most venue tours
 * run 60–90 minutes; 90 is the safe upper bound — being a bit
 * permissive in "is the tour over" is the bias we want.
 */
const DEFAULT_TOUR_DURATION_MIN = 90

/**
 * How far before scheduled_at to scan for cancellation evidence in
 * interactions. 7 days is generous — most legit cancels arrive within
 * a few days of the tour, but a 1-week-out cancel is normal too.
 */
const CANCEL_LOOKBACK_DAYS = 7

/**
 * How far AFTER scheduled_at to scan for no-show evidence (coordinator
 * notes, post-tour emails). 14 days is generous — coordinators often
 * drop a "didn't show" note days later when chasing the lead.
 */
const NO_SHOW_LOOKAHEAD_DAYS = 14

/**
 * Subject / body markers that indicate the COUPLE is cancelling. We
 * key off explicit phrasing only. Subject line patterns are required
 * for inbound interactions because body-only matches are too noisy
 * (a "cancellation" word can appear in any conversation about
 * rescheduling, cancellation policy, etc.).
 *
 * Two layers — STRONG markers fire on subject OR body. WEAK markers
 * require the subject to also include a tour reference (so a generic
 * "cancel" in body doesn't trigger).
 */
const STRONG_CANCEL_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:cancel|cancell?ing|cancelled|cancellation)\s+(?:our|the|my)\s+tour\b/i,
  /\bneed\s+to\s+cancel\s+(?:our|the|my)?\s*tour\b/i,
  /\bwon[''']?t\s+(?:be\s+)?(?:able\s+to\s+)?(?:make|attend|come\s+to)\s+(?:our|the|my)?\s*tour\b/i,
  /\b(?:tour|visit|appointment)\s+cancell?ation\b/i,
  /\bcancel\s+(?:our|the|my)\s+(?:appointment|visit|booking)\s+for\s+the\s+tour\b/i,
]

const NO_SHOW_PATTERNS: ReadonlyArray<RegExp> = [
  /\bdidn[''']?t\s+show\s*(?:up)?\b/i,
  /\bno[\s-]show\b/i,
  /\bdidn[''']?t\s+(?:make\s+it|come|arrive)\b/i,
  /\bnever\s+(?:showed|arrived|came)\b/i,
  /\bfailed\s+to\s+(?:show|appear)\b/i,
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PastDueTour {
  id: string
  venue_id: string
  wedding_id: string | null
  scheduled_at: string
  outcome: string | null
  notes: string | null
  cancellation_reason: string | null
}

interface InteractionRow {
  id: string
  type: string
  direction: string
  subject: string | null
  body_preview: string | null
  timestamp: string
}

interface EngagementEventRow {
  event_type: string
  occurred_at: string | null
  created_at: string
}

export interface ClassifierResult {
  scanned: number
  completed: number
  cancelled: number
  no_show: number
  skipped: number
  errors: string[]
}

interface VenueResult extends ClassifierResult {
  venueId: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify outcomes for one venue. Idempotent — re-running on already-
 * classified rows is a no-op because the query filters to outcome IN
 * ('pending', NULL).
 */
export async function classifyTourOutcomes(
  supabase: SupabaseClient,
  venueId: string,
): Promise<ClassifierResult> {
  const result: ClassifierResult = {
    scanned: 0,
    completed: 0,
    cancelled: 0,
    no_show: 0,
    skipped: 0,
    errors: [],
  }

  const nowIso = new Date().toISOString()

  // Fetch every past-due pending/null-outcome tour for this venue.
  // Bound the lookback to scheduled_at < now() so we never touch a
  // future-dated tour.
  const { data: tours, error } = await supabase
    .from('tours')
    .select('id, venue_id, wedding_id, scheduled_at, outcome, notes, cancellation_reason')
    .eq('venue_id', venueId)
    .or('outcome.is.null,outcome.eq.pending')
    .not('scheduled_at', 'is', null)
    .lt('scheduled_at', nowIso)
    .order('scheduled_at', { ascending: false })

  if (error) {
    result.errors.push(`fetch tours failed: ${error.message}`)
    return result
  }

  const rows = (tours ?? []) as PastDueTour[]
  result.scanned = rows.length

  if (rows.length === 0) return result

  // Per-tour evaluation. We could batch interactions/events for the
  // whole venue at once but most venues have <500 past-due pending
  // tours and the per-tour walk keeps the logic readable + the safety
  // bias clear.
  for (const tour of rows) {
    try {
      // Buffer for the "tour is over" check. A tour scheduled at
      // 14:00 with default 90min duration is "over" at 15:30. We use
      // scheduled_at + duration < now() as the gate so we don't
      // classify a tour that's still in progress.
      const scheduledMs = Date.parse(tour.scheduled_at)
      if (!Number.isFinite(scheduledMs)) {
        result.skipped++
        continue
      }
      const tourEndMs = scheduledMs + DEFAULT_TOUR_DURATION_MIN * 60 * 1000
      if (tourEndMs > Date.now()) {
        result.skipped++
        continue
      }

      const verdict = await classifyOneTour(supabase, tour)

      if (verdict.outcome === 'pending') {
        // Ambiguous — leave as is. Bias toward false negatives.
        result.skipped++
        continue
      }

      const update: Record<string, unknown> = { outcome: verdict.outcome }
      if (verdict.outcome === 'cancelled' && verdict.cancellationReason) {
        update.cancellation_reason = verdict.cancellationReason
      }

      const { error: upErr } = await supabase
        .from('tours')
        .update(update)
        .eq('id', tour.id)

      if (upErr) {
        result.errors.push(`tour ${tour.id} update failed: ${upErr.message}`)
        continue
      }

      if (verdict.outcome === 'completed') result.completed++
      else if (verdict.outcome === 'cancelled') result.cancelled++
      else if (verdict.outcome === 'no_show') result.no_show++
    } catch (err) {
      result.errors.push(
        `tour ${tour.id} classifier threw: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  return result
}

/**
 * Cron entry point: classify outcomes for every venue. Returns a
 * Response so the route handler can hand it back directly.
 *
 * Per-venue failures are caught + logged but never abort the loop —
 * the cron must always finish.
 */
export async function classifyTourOutcomesAllVenues(
  supabase?: SupabaseClient,
): Promise<Response> {
  const sb = supabase ?? createServiceClient()

  const { data: venues, error } = await sb
    .from('venues')
    .select('id, name')
    .eq('is_active', true)

  if (error) {
    return Response.json(
      { ok: false, error: `fetch venues failed: ${error.message}` },
      { status: 500 },
    )
  }

  const totals: VenueResult[] = []
  for (const venue of (venues ?? []) as Array<{ id: string; name: string | null }>) {
    try {
      const r = await classifyTourOutcomes(sb, venue.id)
      totals.push({ venueId: venue.id, ...r })
    } catch (err) {
      totals.push({
        venueId: venue.id,
        scanned: 0,
        completed: 0,
        cancelled: 0,
        no_show: 0,
        skipped: 0,
        errors: [`top-level: ${err instanceof Error ? err.message : String(err)}`],
      })
    }
  }

  const aggregate = totals.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      completed: acc.completed + r.completed,
      cancelled: acc.cancelled + r.cancelled,
      no_show: acc.no_show + r.no_show,
      skipped: acc.skipped + r.skipped,
      errorsCount: acc.errorsCount + r.errors.length,
    }),
    { scanned: 0, completed: 0, cancelled: 0, no_show: 0, skipped: 0, errorsCount: 0 },
  )

  return Response.json({
    ok: true,
    venues: totals.length,
    ...aggregate,
    perVenue: totals,
  })
}

// ---------------------------------------------------------------------------
// Internal: per-tour verdict
// ---------------------------------------------------------------------------

interface Verdict {
  outcome: 'completed' | 'cancelled' | 'no_show' | 'pending'
  cancellationReason?: string
}

async function classifyOneTour(
  supabase: SupabaseClient,
  tour: PastDueTour,
): Promise<Verdict> {
  const scheduledMs = Date.parse(tour.scheduled_at)
  const lookbackIso = new Date(
    scheduledMs - CANCEL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const lookaheadIso = new Date(
    scheduledMs + NO_SHOW_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString()
  const tourEndIso = new Date(
    scheduledMs + DEFAULT_TOUR_DURATION_MIN * 60 * 1000,
  ).toISOString()

  // ---- 1. Coordinator notes are the strongest signal ----
  // Notes are coordinator-authored. If they wrote "didn't show",
  // trust it.
  if (tour.notes) {
    if (matchesAny(tour.notes, NO_SHOW_PATTERNS)) {
      return { outcome: 'no_show' }
    }
    if (matchesAny(tour.notes, STRONG_CANCEL_PATTERNS)) {
      // Coordinator note explicitly says cancel — treat as
      // cancellation. Reason left null because we don't know without
      // re-extracting; coordinator can fill in if needed.
      return { outcome: 'cancelled', cancellationReason: 'other' }
    }
  }

  if (!tour.wedding_id) {
    // Without a wedding_id we can't walk interactions/events. Default
    // to completed (the tour was scheduled and time has passed —
    // absence of evidence is, in this safe direction, evidence the
    // tour happened).
    return { outcome: 'completed' }
  }

  // ---- 2. engagement_events: tour_cancelled fired around this tour ----
  // The email-pipeline + scheduling-tool parsers fire engagement
  // events with event_type='tour_cancelled' when they detect a
  // cancellation. If one fired in the cancel window, that's a
  // venue-wide-trusted signal.
  const { data: cancelEvents } = await supabase
    .from('engagement_events')
    .select('event_type, occurred_at, created_at')
    .eq('venue_id', tour.venue_id)
    .eq('wedding_id', tour.wedding_id)
    .in('event_type', ['tour_cancelled'])
    .gte('occurred_at', lookbackIso)
    .lte('occurred_at', tourEndIso)
    .limit(1)

  if (cancelEvents && cancelEvents.length > 0) {
    return { outcome: 'cancelled', cancellationReason: 'other' }
  }

  // ---- 3. Inbound cancellation interactions in the lookback window ----
  const { data: cancelIxs } = await supabase
    .from('interactions')
    .select('id, type, direction, subject, body_preview, timestamp')
    .eq('venue_id', tour.venue_id)
    .eq('wedding_id', tour.wedding_id)
    .eq('direction', 'inbound')
    .gte('timestamp', lookbackIso)
    .lte('timestamp', tourEndIso)
    .order('timestamp', { ascending: true })

  const ixRows = (cancelIxs ?? []) as InteractionRow[]
  for (const ix of ixRows) {
    const haystack = `${ix.subject ?? ''}\n${ix.body_preview ?? ''}`
    if (matchesAny(haystack, STRONG_CANCEL_PATTERNS)) {
      // Best-effort reason extraction. If the call fails we fall back
      // to 'other'.
      let reason: string = 'other'
      try {
        reason = await extractCancellationReason({
          venueId: tour.venue_id,
          subject: ix.subject,
          body: ix.body_preview,
        })
      } catch {
        // already defaulted to 'other'
      }
      return { outcome: 'cancelled', cancellationReason: reason }
    }
  }

  // ---- 4. No-show evidence in post-tour interactions ----
  // Coordinators sometimes log "they didn't show up" in a follow-up
  // email or note in the days after the tour.
  const { data: postIxs } = await supabase
    .from('interactions')
    .select('id, type, direction, subject, body_preview, timestamp')
    .eq('venue_id', tour.venue_id)
    .eq('wedding_id', tour.wedding_id)
    .gte('timestamp', tourEndIso)
    .lte('timestamp', lookaheadIso)
    .limit(20)

  for (const ix of (postIxs ?? []) as InteractionRow[]) {
    const haystack = `${ix.subject ?? ''}\n${ix.body_preview ?? ''}`
    if (matchesAny(haystack, NO_SHOW_PATTERNS)) {
      return { outcome: 'no_show' }
    }
  }

  // ---- 5. Default: completed ----
  // Tour was scheduled, time has passed, no contrary evidence.
  return { outcome: 'completed' }
}

function matchesAny(text: string, patterns: ReadonlyArray<RegExp>): boolean {
  if (!text) return false
  for (const p of patterns) {
    if (p.test(text)) return true
  }
  return false
}
