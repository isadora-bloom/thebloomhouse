/**
 * "Since you were last here" strip — /today (W42, Monday-walkthrough
 * audit).
 *
 * The audit's second finding: nothing on the app says "12 came in over
 * the weekend, 9 auto-sent, 3 waiting, 0 failed" — the inbox and drafts
 * stats reset at midnight, so a coordinator opening the app on Monday
 * sees Sunday night's numbers, not the weekend's. This adapter answers
 * the question the audit actually asked: what happened between the
 * venue's last business day and right now.
 *
 * Three parts, same shape as `getDailyList` in `canonical.ts`:
 *
 *   1. `computeSinceLastHereWindow` — pure, no database. Today's weekday
 *      decides the window start: Friday 18:00 venue time when today is
 *      Monday, otherwise yesterday 18:00. Deliberately does not know
 *      about public holidays or venue closures — nothing in the spine
 *      records when a venue is shut, so guessing would be an invented
 *      fact, not a measured one. A holiday just falls under the
 *      "otherwise" branch like any other non-Monday.
 *
 *   2. `loadSinceLastHere` — SPINE-ONLY reader. Reads `couples`,
 *      `touchpoints`, `drafts`, `admin_notifications`, never a legacy
 *      table. Injectable core (supabase passed in) so the unit test
 *      drives it with a fake client, no database required; the public
 *      `getSinceLastHere` wraps the service client.
 *
 *   3. `buildSinceLastHereStrip` — pure. Turns the four counts into the
 *      labelled, linked strip the page renders. Unit-tested with
 *      hand-built counts, the same way `buildTriageRail` is tested with
 *      hand-built `DailyList` fixtures in ./daily-list-view.ts.
 *
 * Every count, sourced (no invented numbers):
 *
 *   - arrived : couples whose very first touchpoint ever is inbound
 *     (migration 348 §1 action set — same set `getDailyList` uses for
 *     its needsReply bucket) and falls inside the window. A couple who
 *     wrote in more than once over the window is still one arrival.
 *
 *   - autoSent : drafts with status='sent', auto_sent=true (the
 *     provenance flag `email/pipeline.ts` sets only on the auto-send
 *     path, never on a coordinator's own send), `sent_at` inside the
 *     window. `sent_at` (migration 072) is the actual Gmail send time,
 *     not when the draft was written.
 *
 *   - waiting : couples whose most recent touchpoint (as of now) is
 *     inbound and landed inside the window — something came in during
 *     the window and nothing, auto-sent or manual, has gone back since.
 *
 *   - failed : `admin_notifications` rows with type='auto_send_failed'
 *     and `created_at` inside the window — raised the moment
 *     `flushPendingAutoSends` (email/pipeline.ts) exhausts its retries
 *     and flips a draft to `status='auto_send_failed'`. This is the
 *     only DB-persisted signal of a send failure today. W17 stopped
 *     `/agent/inbox` from swallowing a MANUAL send failure, but that fix
 *     shows a banner in the browser only — nothing is written to the
 *     database when a coordinator's own send fails, so there is no
 *     honest row to count for that case. Left out rather than guessed
 *     at; a future workstream that wants it counted here needs to give
 *     a manual send failure somewhere to land first.
 *
 * Pure builder unit-tested in ./__tests__/since-last-here.test.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { DEFAULT_TIME_ZONE, dayLabel, timeLabel, weekdayIndex, zonedParts } from '@/lib/copy/client-terms'

// ─────────────────────────────────────────────────────────────────────
// 1. The window
// ─────────────────────────────────────────────────────────────────────

export interface SinceLastHereWindow {
  /** Window start, ms epoch. */
  fromMs: number
  /** Window start, ISO — the shape every spine query in this codebase
   *  filters with. */
  fromIso: string
  /** Window end, ms epoch. Always `now`, passed in by the caller. */
  toMs: number
  toIso: string
  timeZone: string
  /** "since Friday, 6:00pm" — what the strip's header says the window
   *  covers. */
  label: string
}

/** The hour a venue's business day is considered to end, venue-local.
 *  CHOSEN — nothing in the spine records a venue's actual office hours,
 *  and 6pm matches the boundary the rest of the coordinator-facing copy
 *  already assumes (a tour after 6pm still reads as "today" on /today,
 *  never "tonight" vs "tomorrow"). */
const BUSINESS_DAY_END_HOUR = 18

/**
 * The UTC instant for a specific wall-clock date + time in a named
 * timezone — the inverse of `zonedParts`. DST-safe: a first guess using
 * the naive offset can land a few minutes either side of the right
 * answer across a transition, so it checks what `zonedParts` says the
 * guess actually landed on and corrects once.
 */
function zonedTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute)
  let guess = target
  for (let i = 0; i < 2; i++) {
    const parts = zonedParts(new Date(guess).toISOString(), timeZone)
    if (!parts) break
    const landedAt = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
    const diff = target - landedAt
    if (diff === 0) break
    guess += diff
  }
  return guess
}

/** Fallback window when the clock or timezone cannot be read at all —
 *  a flat trailing 24 hours, so the strip still shows something true
 *  rather than throwing the whole page. Should not happen in practice:
 *  `now` always comes from `nowMs()` and `timeZone` defaults upstream. */
function fallbackWindow(now: number, timeZone: string): SinceLastHereWindow {
  const fromMs = now - 24 * 60 * 60 * 1000
  return {
    fromMs,
    fromIso: new Date(fromMs).toISOString(),
    toMs: now,
    toIso: new Date(now).toISOString(),
    timeZone,
    label: 'in the last day',
  }
}

/**
 * Window start = the venue's last business-day end, venue-local:
 *   - today is Monday  → Friday 18:00 (3 calendar days back)
 *   - otherwise        → yesterday 18:00
 *
 * Weekday-only on purpose. A public holiday that closed the venue on,
 * say, a Wednesday still gets "Tuesday 18:00" as its window start on
 * Thursday morning — see the file header for why that is the honest
 * choice, not a bug.
 */
export function computeSinceLastHereWindow(
  now: number,
  timeZone: string = DEFAULT_TIME_ZONE,
): SinceLastHereWindow {
  const today = zonedParts(new Date(now).toISOString(), timeZone)
  if (!today) return fallbackWindow(now, timeZone)

  const isMonday = weekdayIndex(today) === 1
  const daysBack = isMonday ? 3 : 1

  // Anchor on UTC noon of today's calendar date so the day-arithmetic
  // below is pure calendar maths, never wall-clock maths — subtracting
  // whole days from a midday anchor cannot cross a DST boundary into
  // the wrong calendar date.
  const todayNoonUtc = Date.UTC(today.year, today.month - 1, today.day, 12)
  const target = new Date(todayNoonUtc - daysBack * 24 * 60 * 60 * 1000)

  const fromMs = zonedTimeToUtcMs(
    target.getUTCFullYear(),
    target.getUTCMonth() + 1,
    target.getUTCDate(),
    BUSINESS_DAY_END_HOUR,
    0,
    timeZone,
  )
  const fromIso = new Date(fromMs).toISOString()

  const day = dayLabel(fromIso, timeZone)
  const time = timeLabel(fromIso, timeZone)
  const label = day && time ? `since ${day}, ${time}` : day ? `since ${day}` : 'since your last visit'

  return {
    fromMs,
    fromIso,
    toMs: now,
    toIso: new Date(now).toISOString(),
    timeZone,
    label,
  }
}

// ─────────────────────────────────────────────────────────────────────
// 2. The reader
// ─────────────────────────────────────────────────────────────────────

/** Inbound, progression-eligible (channel, action_type) pairs — mirrors
 *  migration 348 §1, the same set `getDailyList` uses for its
 *  needsReply bucket. Duplicated rather than imported: this adapter's
 *  ownership is `src/lib/intel/adapters/**`, not `canonical.ts`, and the
 *  set is small enough that a local copy is cheaper mid-wave than a
 *  cross-workstream edit. If the two ever drift, the fix is to export
 *  the set once from canonical.ts and delete this copy. */
const INBOUND_ACTIONS: Record<string, ReadonlySet<string>> = {
  gmail: new Set(['reply', 'inquiry']),
  calendly: new Set(['tour_booked', 'tour_attended']),
  honeybook: new Set(['contract_signed', 'booking_signed']),
  knot: new Set(['inquiry', 'message', 'inquiry_form']),
  weddingwire: new Set(['inquiry', 'message', 'inquiry_form']),
  zola: new Set(['inquiry', 'message', 'inquiry_form']),
  portal: new Set(['portal_click', 'portal_visit']),
  website: new Set(['inquiry_form_submitted']),
}

function isInboundTouchpoint(channel: string, actionType: string): boolean {
  return INBOUND_ACTIONS[channel]?.has(actionType) ?? false
}

function inWindow(iso: string | null | undefined, window: SinceLastHereWindow): boolean {
  if (!iso) return false
  return iso >= window.fromIso && iso <= window.toIso
}

interface RawCoupleRow {
  id: string
}
interface RawTouchpointRow {
  couple_id: string | null
  channel: string
  action_type: string
  occurred_at: string
}

const COUPLE_FETCH_LIMIT = 5000
const TOUCHPOINT_FETCH_LIMIT = 20000
const ROW_FETCH_LIMIT = 5000

export interface SinceLastHereCounts {
  arrived: number
  autoSent: number
  waiting: number
  failed: number
  window: SinceLastHereWindow
  generatedAt: string
}

function emptyCounts(window: SinceLastHereWindow): SinceLastHereCounts {
  return { arrived: 0, autoSent: 0, waiting: 0, failed: 0, window, generatedAt: new Date().toISOString() }
}

/**
 * SPINE-ONLY reader for the four "since you were last here" counts.
 * Venue-scoped, excludes merged-away couples (`merged_into_id IS NULL`,
 * consistent with `getDailyList` / `getVenueOverview`). Honest-empty on
 * a missing venueId.
 */
export async function loadSinceLastHere(
  supabase: SupabaseClient,
  venueId: string,
  window: SinceLastHereWindow,
): Promise<SinceLastHereCounts> {
  if (!venueId) return emptyCounts(window)

  const { data: coupleData, error: coupleErr } = await supabase
    .from('couples')
    .select('id')
    .eq('venue_id', venueId)
    .is('merged_into_id', null)
    .limit(COUPLE_FETCH_LIMIT)
  if (coupleErr) throw new Error(`loadSinceLastHere: couples ${coupleErr.message}`)
  const validCoupleIds = new Set(((coupleData ?? []) as RawCoupleRow[]).map((c) => c.id))

  const { data: tpData, error: tpErr } = await supabase
    .from('touchpoints')
    .select('couple_id, channel, action_type, occurred_at')
    .eq('venue_id', venueId)
    .limit(TOUCHPOINT_FETCH_LIMIT)
  if (tpErr) throw new Error(`loadSinceLastHere: touchpoints ${tpErr.message}`)

  const byCouple = new Map<string, RawTouchpointRow[]>()
  for (const t of (tpData ?? []) as RawTouchpointRow[]) {
    if (!t.couple_id || !validCoupleIds.has(t.couple_id)) continue
    const arr = byCouple.get(t.couple_id)
    if (arr) arr.push(t)
    else byCouple.set(t.couple_id, [t])
  }

  let arrived = 0
  let waiting = 0
  for (const rows of byCouple.values()) {
    const sorted = [...rows].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : a.occurred_at > b.occurred_at ? 1 : 0))
    const earliest = sorted[0]
    const latest = sorted[sorted.length - 1]
    if (earliest && isInboundTouchpoint(earliest.channel, earliest.action_type) && inWindow(earliest.occurred_at, window)) {
      arrived++
    }
    if (latest && isInboundTouchpoint(latest.channel, latest.action_type) && inWindow(latest.occurred_at, window)) {
      waiting++
    }
  }

  const { data: draftData, error: draftErr } = await supabase
    .from('drafts')
    .select('id, sent_at')
    .eq('venue_id', venueId)
    .eq('status', 'sent')
    .eq('auto_sent', true)
    .gte('sent_at', window.fromIso)
    .lte('sent_at', window.toIso)
    .limit(ROW_FETCH_LIMIT)
  if (draftErr) throw new Error(`loadSinceLastHere: drafts ${draftErr.message}`)
  const autoSent = (draftData ?? []).length

  const { data: failData, error: failErr } = await supabase
    .from('admin_notifications')
    .select('id, created_at')
    .eq('venue_id', venueId)
    .eq('type', 'auto_send_failed')
    .gte('created_at', window.fromIso)
    .lte('created_at', window.toIso)
    .limit(ROW_FETCH_LIMIT)
  if (failErr) throw new Error(`loadSinceLastHere: admin_notifications ${failErr.message}`)
  const failed = (failData ?? []).length

  return { arrived, autoSent, waiting, failed, window, generatedAt: new Date().toISOString() }
}

export async function getSinceLastHere(
  venueId: string,
  window: SinceLastHereWindow,
): Promise<SinceLastHereCounts> {
  if (!venueId) return emptyCounts(window)
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadSinceLastHere(createServiceClient(), venueId, window)
}

// ─────────────────────────────────────────────────────────────────────
// 3. The strip
// ─────────────────────────────────────────────────────────────────────

export type SinceLastHereKey = 'arrived' | 'autoSent' | 'waiting' | 'failed'

export interface SinceLastHereItem {
  key: SinceLastHereKey
  label: string
  count: number
  /** The rule that defines this count, in plain words — so a coordinator
   *  (or an engineer checking the number) can see WHY it is what it is,
   *  not just that it is. Same convention as `TriageBucket.rule`. */
  rule: string
  /** Where the rule comes from, auditable rather than magic. */
  source: string
  /** The list this count is a headline for. */
  href: string
}

export interface SinceLastHereStrip {
  /** "since Friday, 6:00pm". */
  windowLabel: string
  items: SinceLastHereItem[]
  /** True when every count is zero — a quiet window is good news, not
   *  missing data, so the page can say that rather than draw four
   *  zeroes with no context. */
  allZero: boolean
}

/** Pure. Turns the four sourced counts into the strip the page renders.
 *  Unit-tested with hand-built `SinceLastHereCounts` — no database, same
 *  pattern as `buildTriageRail`. */
export function buildSinceLastHereStrip(counts: SinceLastHereCounts): SinceLastHereStrip {
  const items: SinceLastHereItem[] = [
    {
      key: 'arrived',
      label: 'Inquiries arrived',
      count: counts.arrived,
      rule: "New couples whose very first message came in during this window.",
      source:
        'loadSinceLastHere — inbound action set mirrors migration 348 §1, the same set getDailyList uses.',
      href: '/agent/leads',
    },
    {
      key: 'autoSent',
      label: 'Auto-sent',
      count: counts.autoSent,
      rule: 'Replies that went out on their own during this window — nobody approved these by hand.',
      source: "loadSinceLastHere — drafts.status='sent' and auto_sent=true, windowed on sent_at (migration 072).",
      href: '/agent/drafts',
    },
    {
      key: 'waiting',
      label: 'Waiting for a reply',
      count: counts.waiting,
      rule: 'Couples whose most recent message arrived during this window, with nothing sent back since.',
      source: 'loadSinceLastHere — latest touchpoint per couple is inbound and falls inside the window.',
      href: '/agent/inbox',
    },
    {
      key: 'failed',
      label: 'Send failures',
      count: counts.failed,
      rule: 'Auto-send tried and used up its retries during this window. Each one still needs a reply.',
      source:
        "loadSinceLastHere — admin_notifications type='auto_send_failed', raised when a draft is set to status='auto_send_failed'.",
      href: '/pulse',
    },
  ]

  return {
    windowLabel: counts.window.label,
    items,
    allZero: items.every((i) => i.count === 0),
  }
}
