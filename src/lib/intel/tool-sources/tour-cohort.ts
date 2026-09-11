/**
 * Tour cohort by explicit date window. NOVEMBER-PLAN.md wave 4, W32.
 * Battery Q37 link 1: "Find everyone I had a tour with this weekend."
 *
 * `get_daily_list`'s `toursThisWeek` bucket is a FORWARD window only
 * (now to +7 days), because the daily list is a working list for today
 * onward. "This weekend" asked on a Monday is a window that has already
 * passed, so the cohort is not in that bucket at all — the July battery
 * run answered Q37 by inventing attendees because it had nowhere honest
 * to look. This source is the honest place to look: an explicit
 * `period_from` / `period_to` that can point either direction in time.
 *
 * Spine only, no legacy join. A tour's outcome lives on the couple's own
 * touchpoint ribbon as one of four action types (calendly-outcomes.ts):
 *
 *   tour_booked     the booking itself. occurred_at is the scheduled
 *                    tour time (calendly-to-signal.ts stamps it from
 *                    the Calendly payload's scheduled_event.start_time,
 *                    not the time the booking was made).
 *   tour_attended    derived by the daily attendance sweep once the
 *                    tour time has passed with no cancellation.
 *                    occurred_at is again the scheduled tour time.
 *   tour_cancelled   fired by the Calendly cancellation webhook.
 *                    occurred_at is the moment of cancellation, so the
 *                    tour time is read from raw_payload.scheduled_start
 *                    instead (see resolveTourTime below).
 *   tour_no_show     reserved for a future operator-marked override;
 *                    not written by any pipeline yet, handled here so
 *                    the day it is starts working with no further change.
 *
 * A booking and its eventual outcome are the same physical tour, so they
 * are grouped by (couple, resolved tour time) and reduced to one outcome
 * per group, terminal state winning over a bare booking: cancelled >
 * no_show > attended > scheduled.
 *
 * Names come from `couples` only, the same tombstone-safe pattern
 * follow-ups.ts uses (`merged_into_id IS NULL`). A touchpoint whose
 * couple record cannot be resolved is not silently dropped: it stays in
 * the count and is reported unresolved rather than given an invented
 * name.
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { IntelToolSource, ToolSourceDeps } from './types'
import { zonedParts } from '@/lib/services/cohort/helpers'

export const TOOL_GET_TOUR_COHORT = 'get_tour_cohort'

/** The four outcome touchpoint action types a tour can carry. */
const TOUR_ACTION_TYPES = ['tour_booked', 'tour_attended', 'tour_no_show', 'tour_cancelled'] as const

/** Most tours this source will read in one call. Bounded, not because a
 *  venue can't have more, but because the four action types together are
 *  a narrow slice of the ribbon and this is well past a year of tours at
 *  Rixey scale. */
const TOUCHPOINT_SCAN_LIMIT = 5000

/** Cap on how many tours are named back in one answer. A weekend is a
 *  handful; fifty is already a very good month. Past the cap the answer
 *  says so instead of silently truncating. */
export const TOUR_COHORT_CAP = 50

export type TourOutcomeFilter = 'attended' | 'no_show' | 'cancelled' | 'scheduled' | 'any'
const VALID_OUTCOME_FILTERS: ReadonlySet<string> = new Set([
  'attended',
  'no_show',
  'cancelled',
  'scheduled',
  'any',
])

type ResolvedOutcome = 'attended' | 'no_show' | 'cancelled' | 'scheduled'

interface TourTouchpointRow {
  couple_id: string | null
  action_type: string | null
  occurred_at: string | null
  raw_payload: Record<string, unknown> | null
}

interface CoupleRow {
  id: string
  primary_contact_name: string | null
  partner_contact_name: string | null
  lifecycle_state: string | null
}

interface TourGroup {
  coupleId: string
  /** Resolved tour time, ISO. Grouping key alongside coupleId. */
  tourAt: string
  actionTypes: Set<string>
}

// ---------------------------------------------------------------------------
// Small date helpers, deliberately local rather than imported: these are
// calendar-string arithmetic on YYYY-MM-DD, not the display/percentile
// helpers the rest of cohort/helpers.ts is for.
// ---------------------------------------------------------------------------

function isDateKey(v: unknown): v is string {
  return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
}

function addDaysToDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

/** The window to query, plus whether it was defaulted. `deps.today` is
 *  already venue-local (the dispatcher computes it from venue_config), so
 *  defaulting off it keeps "the last 7 days" meaning the venue's own last
 *  7 days, not the server's. */
function resolveWindow(
  args: Record<string, unknown>,
  today: string,
): { from: string; to: string; defaulted: boolean } {
  const rawFrom = str(args, 'period_from')
  const rawTo = str(args, 'period_to')
  const todayKey = isDateKey(today) ? today : String(today).slice(0, 10)

  if (!rawFrom && !rawTo) {
    return { from: addDaysToDateKey(todayKey, -6), to: todayKey, defaulted: true }
  }
  return {
    from: isDateKey(rawFrom) ? rawFrom : (rawFrom ?? '1900-01-01'),
    to: isDateKey(rawTo) ? rawTo : (rawTo ?? '2999-12-31'),
    defaulted: false,
  }
}

function parseOutcomeFilter(args: Record<string, unknown>): TourOutcomeFilter {
  const raw = args.outcome
  return typeof raw === 'string' && VALID_OUTCOME_FILTERS.has(raw) ? (raw as TourOutcomeFilter) : 'any'
}

/** The tour's actual scheduled time. tour_booked and tour_attended stamp
 *  occurred_at with it directly; tour_cancelled stamps occurred_at with
 *  the moment of cancellation instead, so its tour time has to come from
 *  raw_payload.scheduled_start (calendly-to-signal.ts). Falls back to
 *  occurred_at when neither is a usable string. */
function resolveTourTime(row: TourTouchpointRow): string | null {
  const raw = row.raw_payload
  const scheduledStart =
    raw && typeof raw === 'object' && typeof raw.scheduled_start === 'string' && raw.scheduled_start
      ? raw.scheduled_start
      : null
  const candidate = scheduledStart ?? row.occurred_at
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null
}

/** Terminal state wins over a bare booking. Cancelled and no-show are both
 *  terminal; cancelled is checked first only because it is the far more
 *  common of the two in production today (no_show has no writer yet). */
function resolveOutcome(actionTypes: ReadonlySet<string>): ResolvedOutcome {
  if (actionTypes.has('tour_cancelled')) return 'cancelled'
  if (actionTypes.has('tour_no_show')) return 'no_show'
  if (actionTypes.has('tour_attended')) return 'attended'
  return 'scheduled'
}

/** Venue-local calendar time, formatted for display. Mirrors the style
 *  operator-query.ts's formatAnchorLabel uses, but actually passes the
 *  venue timeZone through to Intl (that file's version does not, and
 *  silently renders in the server's own zone — not repeated here). */
function formatVenueLocal(iso: string, timeZone: string): string | null {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }
  try {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone }).format(new Date(ms))
  } catch {
    return new Intl.DateTimeFormat('en-US', { ...opts, timeZone: 'UTC' }).format(new Date(ms))
  }
}

/** `venue_config.timezone`, the same operator-facing setting every other
 *  venue-local rendering in the tool sources reads (time-series.ts carries
 *  an identical loader; duplicated here rather than imported so this file
 *  has no dependency on a sibling tool source's internals). Defaults to
 *  America/New_York, matching venue_config's own migration-001 default. */
async function loadVenueTimezone(supabase: SupabaseClient, venueId: string): Promise<string> {
  try {
    const { data } = await supabase
      .from('venue_config')
      .select('timezone')
      .eq('venue_id', venueId)
      .maybeSingle()
    const tz = (data as { timezone?: unknown } | null)?.timezone
    return typeof tz === 'string' && tz.trim().length > 0 ? tz.trim() : 'America/New_York'
  } catch {
    return 'America/New_York'
  }
}

/** Couple names + lifecycle, spine only. Rows the caller asked for that
 *  are not returned here (merged away, or simply missing) are reported by
 *  the caller as unresolved rather than assumed. */
async function loadCoupleRows(
  supabase: SupabaseClient,
  venueId: string,
  coupleIds: readonly string[],
): Promise<Map<string, CoupleRow>> {
  const out = new Map<string, CoupleRow>()
  if (coupleIds.length === 0) return out
  const { data, error } = await supabase
    .from('couples')
    .select('id, primary_contact_name, partner_contact_name, lifecycle_state')
    .eq('venue_id', venueId)
    .in('id', coupleIds)
    .is('merged_into_id', null)
  if (error) throw new Error(`get_tour_cohort: couples ${error.message}`)
  for (const row of (data ?? []) as CoupleRow[]) out.set(row.id, row)
  return out
}

function coupleNames(primary: string | null, partner: string | null): string | null {
  if (primary && partner) return `${primary} & ${partner}`
  return primary ?? partner ?? null
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const tool: Anthropic.Tool = {
  name: TOOL_GET_TOUR_COHORT,
  description:
    'Everyone with a tour in an EXPLICIT date window, past or future: who toured this weekend, which ' +
    'tours are next Tuesday, who toured in August. Unlike get_daily_list, whose toursThisWeek bucket ' +
    'only looks forward from right now, this tool takes the window as an argument, so a past weekend or ' +
    'any other window in either direction is answered directly rather than coming back empty. Returns ' +
    'each tour with the couple name (resolved from the spine, never invented), the couple id, the tour ' +
    'time in the venue local timezone, and the outcome (attended, no_show, cancelled, or scheduled ' +
    'meaning booked with no outcome recorded yet). Chain the returned couple ids into ' +
    'get_follow_up_state and then propose_follow_ups to draft follow-ups. Use this, not get_daily_list, ' +
    'whenever the operator names a specific window instead of asking for "this week" starting now.',
  input_schema: {
    type: 'object',
    properties: {
      period_from: {
        type: 'string',
        description:
          'Inclusive start of the window, ISO date (YYYY-MM-DD). May be in the past or the future. ' +
          'Omit together with period_to for the last 7 days.',
      },
      period_to: {
        type: 'string',
        description:
          'Inclusive end of the window, ISO date (YYYY-MM-DD). May be in the past or the future. ' +
          'Omit together with period_from for the last 7 days.',
      },
      outcome: {
        type: 'string',
        enum: ['attended', 'no_show', 'cancelled', 'scheduled', 'any'],
        description:
          "Filter to one outcome. 'scheduled' means booked with no attendance/cancellation recorded " +
          "yet. Defaults to 'any'.",
      },
    },
    additionalProperties: false,
  },
}

async function run(
  venueId: string,
  args: Record<string, unknown>,
  deps: ToolSourceDeps,
): Promise<unknown> {
  const timezone = await loadVenueTimezone(deps.supabase, venueId)
  const { from, to, defaulted } = resolveWindow(args, deps.today)
  const outcomeFilter = parseOutcomeFilter(args)

  const { data, error } = await deps.supabase
    .from('touchpoints')
    .select('couple_id, action_type, occurred_at, raw_payload')
    .eq('venue_id', venueId)
    .in('action_type', TOUR_ACTION_TYPES as unknown as string[])
    .not('couple_id', 'is', null)
    .order('occurred_at', { ascending: true })
    .limit(TOUCHPOINT_SCAN_LIMIT)
  if (error) {
    return { n: 0, enoughData: false, reason: `touchpoints read failed: ${error.message}` }
  }

  // Group by (couple, resolved tour time): a booking and its eventual
  // outcome touchpoint are the same physical tour.
  const groups = new Map<string, TourGroup>()
  for (const row of (data ?? []) as TourTouchpointRow[]) {
    if (!row.couple_id || !row.action_type) continue
    const tourAt = resolveTourTime(row)
    if (!tourAt) continue
    const parts = zonedParts(tourAt, timezone)
    if (!parts) continue
    if (parts.dateKey < from || parts.dateKey > to) continue
    const key = `${row.couple_id}::${tourAt}`
    let group = groups.get(key)
    if (!group) {
      group = { coupleId: row.couple_id, tourAt, actionTypes: new Set() }
      groups.set(key, group)
    }
    group.actionTypes.add(row.action_type)
  }

  let entries = Array.from(groups.values()).map((g) => ({
    coupleId: g.coupleId,
    tourAt: g.tourAt,
    outcome: resolveOutcome(g.actionTypes),
  }))
  if (outcomeFilter !== 'any') {
    entries = entries.filter((e) => e.outcome === outcomeFilter)
  }
  entries.sort((a, b) => a.tourAt.localeCompare(b.tourAt))

  const n = entries.length
  const capped = n > TOUR_COHORT_CAP
  const visible = entries.slice(0, TOUR_COHORT_CAP)

  const coupleIds = Array.from(new Set(visible.map((e) => e.coupleId)))
  const couplesById = await loadCoupleRows(deps.supabase, venueId, coupleIds)

  let unresolved = 0
  const tours = visible.map((e) => {
    const c = couplesById.get(e.coupleId)
    if (!c) unresolved += 1
    return {
      coupleId: e.coupleId,
      names: c ? coupleNames(c.primary_contact_name, c.partner_contact_name) : null,
      lifecycle: c?.lifecycle_state ?? null,
      outcome: e.outcome,
      tourAt: e.tourAt,
      tourAtVenueLocal: formatVenueLocal(e.tourAt, timezone),
      ...(c ? {} : { identityNote: 'No couple record found for this touchpoint (merged or missing).' }),
    }
  })

  const result: Record<string, unknown> = {
    periodFrom: from,
    periodTo: to,
    defaultedToLastSevenDays: defaulted,
    outcome: outcomeFilter,
    timezone,
    n,
    returned: tours.length,
    unresolved,
    cap: TOUR_COHORT_CAP,
    capped,
    tours,
  }

  if (capped) {
    result.capNote =
      `${n} tours matched this window and outcome filter; only the first ${TOUR_COHORT_CAP}, earliest ` +
      'first, are shown here. Narrow the window or the outcome filter to see the rest.'
  }

  if (n === 0) {
    // Mirrors the wording toursBucketWasEmpty's caller uses in tools.ts
    // for get_daily_list's toursThisWeek, so the grounding check's name
    // gate and this tool's empty case read the same way to the model.
    result.note = 'No tours matched this window. There is nobody to name.'
  } else {
    result.nextStep =
      'Call get_follow_up_state with these couple ids before drafting anything, so a couple who has ' +
      'already been followed up with is skipped rather than emailed twice. Once the operator confirms ' +
      'who to draft for, call propose_follow_ups.'
  }

  return result
}

export const tourCohortSource: IntelToolSource = {
  tool,
  subjects: [
    'who had a tour in a specific past or future date window (not just this week)',
    'this weekend, last week, next Tuesday style tour look-ups',
    'tour outcomes (attended, no-show, cancelled, still scheduled) for a named window',
  ],
  batteryQuestions: ['37'],
  run,
}
