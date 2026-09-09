/**
 * The /today view model.
 *
 * Pure. Takes what the canonical readers already returned and turns it
 * into the words on the page. No database, no fetch, no clock of its own
 * (`now` is passed in), so the whole surface is unit-testable from
 * fixtures.
 *
 * Two rules it exists to enforce:
 *
 *   1. No internal vocabulary reaches the screen. Everything that a
 *      coordinator reads goes through `@/lib/copy/client-terms`.
 *   2. Every row says WHY it is on the list, in one line, out of facts
 *      the reader actually returned. If a fact is missing, the line gets
 *      shorter — it never gets invented.
 *
 * The page component below this is a dumb renderer, per
 * INTEL-CANONICAL-API.md §1.
 */

import type { DailyList, DailyListItem, TourRef, VenueOverview } from '@/lib/intel/canonical'
import {
  DEFAULT_TIME_ZONE,
  agoPhrase,
  channelLabel,
  countPhrase,
  dayLabel,
  lifecycleCount,
  timeLabel,
  whenLabel,
} from '@/lib/copy/client-terms'

// ─────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────

export type TodayBlockKey = 'needs-reply' | 'going-quiet' | 'tours' | 'ready-to-book'

export interface TodayRow {
  /** Stable react key — the tour id for tours, the couple id otherwise. */
  key: string
  coupleId: string
  /** What to print as the name. Never blank, never a raw id. */
  name: string
  /** One line, plain English, saying why this row is here. */
  why: string
  action: { label: string; href: string }
}

export interface TodayBlock {
  key: TodayBlockKey
  title: string
  /** One line under the title saying what the block counts and how it
   *  decides. This is the block's "why this number". */
  blurb: string
  /** The full count, not the number of rows shown. */
  count: number
  rows: TodayRow[]
  /** How many rows the cap hid. 0 when everything is shown. */
  hidden: number
  /** Warm, specific copy for when `count` is 0. */
  empty: string
}

export interface TodayPulseRow {
  id: string
  title: string
  body: string | null
  href: string | null
  /** 'Needs a look now' / 'Worth a look' / 'For information'. */
  urgency: string
  when: string | null
}

export interface TodayMaturity {
  current: number
  threshold: number
  unit: string
  unlocks: string
}

export interface TodayViewModel {
  /** One sentence. The whole venue, in plain words. */
  briefing: string
  /** True when there is nothing behind the briefing yet, in which case
   *  `briefing` carries the reason rather than counts. */
  briefingIsReason: boolean
  blocks: TodayBlock[]
  pulse: TodayPulseRow[]
  /** Present only when the venue is still below the data threshold. */
  maturity: TodayMaturity | null
  /** True when all four blocks are empty — drives the "quiet day" note. */
  allClear: boolean
  /** "as at Mon 8 Sep" — so a stale tab is obvious. */
  asAt: string | null
}

/** Anything with the shape of a pulse item. Kept structural so the view
 *  model does not import the pulse aggregator. */
export interface PulseLike {
  id: string
  priority: 'critical' | 'high' | 'medium' | 'low'
  title: string
  body: string | null
  href: string | null
  createdAt: string
}

export interface TodayInputs {
  daily: DailyList
  overview: VenueOverview
  pulse: PulseLike[]
  now: number
  /** `venues.timezone`. Every date and time on the page is rendered in
   *  it, never in the server's zone — a Vercel function runs in UTC, and
   *  a 7pm Friday tour would otherwise read as Saturday. */
  timeZone?: string
}

// ─────────────────────────────────────────────────────────────────────
// Thresholds used by this surface
// ─────────────────────────────────────────────────────────────────────

/** Rows shown per block before the list is capped. CHOSEN: six fits on a
 *  390px screen without scrolling past the next block's heading. */
export const ROWS_PER_BLOCK = 6

/** Pulse items shown on /today. The brief for this page is three; the
 *  rest stay on /pulse. */
export const PULSE_ROWS = 3

/** Couples a venue needs before the four blocks are worth trusting as a
 *  picture rather than as a handful of rows. CHOSEN for this surface —
 *  the readers carry no threshold of their own for a raw couple count.
 *  Below it, the page still shows every real row; it just says out loud
 *  that this is early days. */
export const MATURITY_THRESHOLD_COUPLES = 10

// ─────────────────────────────────────────────────────────────────────
// Names
// ─────────────────────────────────────────────────────────────────────

/** A couple with no captured name is a real state, not an error. Say so
 *  rather than printing a UUID or the word "Unknown". */
export function displayName(names: string | null | undefined): string {
  const trimmed = names?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : 'Name not captured yet'
}

function hasRealName(names: string | null | undefined): boolean {
  return !!names && names.trim().length > 0
}

// ─────────────────────────────────────────────────────────────────────
// Why lines
// ─────────────────────────────────────────────────────────────────────

/** "They wrote in by email 3 days ago and nothing has gone back yet." */
export function needsReplyWhy(item: DailyListItem, now: number): string {
  const ago = agoPhrase(item.lastTouchpointAt, now)
  const where = item.lastChannel ? ` by ${channelLabel(item.lastChannel)}` : ''
  if (!ago) return 'Their message is the last one in the thread. Nothing has gone back yet.'
  return `They wrote in${where} ${ago}, and nothing has gone back yet.`
}

/** "Quiet for 94 days. At 120 they drop off your active list." */
export function goingQuietWhy(item: DailyListItem): string {
  const days = item.quietDays
  const window = item.windowDays
  if (days === null || days === undefined) {
    return 'Nothing has moved on this one for a while, and they are drifting off your active list.'
  }
  const quiet = `Quiet for ${countPhrase(days, 'day')}.`
  if (!window) return `${quiet} They are drifting off your active list.`
  return `${quiet} At ${window} they drop off your active list.`
}

/** "Tour tomorrow, 2:00pm." */
export function tourWhy(tour: TourRef, now: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  const when = whenLabel(tour.scheduledAt, now, timeZone)
  if (!when) return 'Tour booked in the next seven days.'
  const t = timeLabel(tour.scheduledAt, timeZone)
  const lead = when === 'today' || when === 'tomorrow' ? when : `on ${when}`
  return t ? `Tour ${lead}, ${t}.` : `Tour ${lead}.`
}

/** "One of the most active couples you have right now. Last heard from
 *  them yesterday." Never prints the score. */
export function readyToBookWhy(item: DailyListItem, now: number): string {
  const head = 'One of the most active couples you have right now.'
  const ago = agoPhrase(item.lastTouchpointAt, now)
  if (!ago) return head
  return `${head} Last heard from them ${ago}.`
}

// ─────────────────────────────────────────────────────────────────────
// Actions
// ─────────────────────────────────────────────────────────────────────

/** The inbox search box is the only way into a couple's email thread from
 *  a link (`/agent/inbox?q=`). When we have no name to search on, send
 *  them to the couple instead of to an empty search. */
export function openThreadAction(item: DailyListItem): TodayRow['action'] {
  if (hasRealName(item.names)) {
    return { label: 'Open their emails', href: `/agent/inbox?q=${encodeURIComponent(item.names!.trim())}` }
  }
  return { label: 'Open the couple', href: `/intel/couples/${item.id}` }
}

export function openCoupleAction(coupleId: string): TodayRow['action'] {
  return { label: 'Open the couple', href: `/intel/couples/${coupleId}` }
}

// ─────────────────────────────────────────────────────────────────────
// Briefing
// ─────────────────────────────────────────────────────────────────────

/** Lifecycle states worth saying out loud in the one-line briefing, in
 *  the order a coordinator thinks about them. `agent` is left out on
 *  purpose: those rows are not couples. `completed` is left out because a
 *  finished wedding is not part of this morning. */
const BRIEFING_STATES = ['resolved', 'channel_scoped', 'booked', 'ghost'] as const

/**
 * "You have 38 couples on file: 12 in conversation, 8 new enquiries,
 *  3 booked, 15 gone quiet."
 *
 * When the venue has no messages at all, the counts would be a lie
 * dressed as a summary, so the reason is returned instead.
 */
export function buildBriefing(overview: VenueOverview): { text: string; isReason: boolean } {
  const total = overview.couples.total
  if (overview.dataMaturity.n === 0 || total === 0) {
    return {
      text: 'Nothing has come in yet, so there is nothing to say about your couples this morning.',
      isReason: true,
    }
  }
  const parts = BRIEFING_STATES.map((state) => ({
    state,
    n: overview.couples.byLifecycle[state] ?? 0,
  }))
    .filter((p) => p.n > 0)
    .map((p) => lifecycleCount(p.state, p.n))

  const head = `You have ${countPhrase(total, 'couple')} on file`
  if (parts.length === 0) return { text: `${head}.`, isReason: false }
  return { text: `${head}: ${parts.join(', ')}.`, isReason: false }
}

// ─────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────

const URGENCY: Record<PulseLike['priority'], string> = {
  critical: 'Needs a look now',
  high: 'Needs a look now',
  medium: 'Worth a look',
  low: 'For information',
}

function cap<T>(rows: T[]): { shown: T[]; hidden: number } {
  if (rows.length <= ROWS_PER_BLOCK) return { shown: rows, hidden: 0 }
  return { shown: rows.slice(0, ROWS_PER_BLOCK), hidden: rows.length - ROWS_PER_BLOCK }
}

function toursEmptyCopy(nextTourAt: string | null | undefined, timeZone: string): string {
  const next = dayLabel(nextTourAt, timeZone)
  if (next) return `No tours this week. The next one is ${next}.`
  return 'No tours this week, and none on the books after it either.'
}

// ─────────────────────────────────────────────────────────────────────
// The builder
// ─────────────────────────────────────────────────────────────────────

export function buildTodayViewModel(input: TodayInputs): TodayViewModel {
  const { daily, overview, pulse, now } = input
  const timeZone = input.timeZone || DEFAULT_TIME_ZONE

  const needsReply = cap(daily.needsReply)
  const goingQuiet = cap(daily.goingCold)
  const tours = cap(daily.toursThisWeek)
  const ready = cap(daily.highIntent)

  const blocks: TodayBlock[] = [
    {
      key: 'needs-reply',
      title: 'Needs a reply',
      blurb:
        'Couples whose message is the last one in the thread. Booked couples and ones who have gone quiet are left out.',
      count: daily.needsReply.length,
      hidden: needsReply.hidden,
      rows: needsReply.shown.map((item) => ({
        key: item.id,
        coupleId: item.id,
        name: displayName(item.names),
        why: needsReplyWhy(item, now),
        action: openThreadAction(item),
      })),
      empty: 'Nothing is waiting on you. Everyone who wrote in has had an answer.',
    },
    {
      key: 'going-quiet',
      title: 'Going quiet',
      blurb:
        'Couples you are still talking to who have gone quiet for most of the time you give them. Still worth a nudge.',
      count: daily.goingCold.length,
      hidden: goingQuiet.hidden,
      rows: goingQuiet.shown.map((item) => ({
        key: item.id,
        coupleId: item.id,
        name: displayName(item.names),
        why: goingQuietWhy(item),
        action: openCoupleAction(item.id),
      })),
      empty: 'Nobody is drifting. Everyone you are talking to has been in touch recently.',
    },
    {
      key: 'tours',
      title: 'Tours this week',
      blurb: 'Tours booked in the next seven days. Cancellations and no-shows are left out.',
      count: daily.toursThisWeek.length,
      hidden: tours.hidden,
      rows: tours.shown.map((tour) => ({
        key: tour.id,
        coupleId: tour.coupleId,
        name: displayName(tour.names),
        why: tourWhy(tour, now, timeZone),
        action: openCoupleAction(tour.coupleId),
      })),
      empty: toursEmptyCopy(daily.nextTourAt, timeZone),
    },
    {
      key: 'ready-to-book',
      title: 'Ready to book',
      blurb:
        'The couples showing the most activity right now, most active first. At most ten are listed.',
      count: daily.highIntent.length,
      hidden: ready.hidden,
      rows: ready.shown.map((item) => ({
        key: item.id,
        coupleId: item.id,
        name: displayName(item.names),
        why: readyToBookWhy(item, now),
        action: openCoupleAction(item.id),
      })),
      empty:
        'Nobody is standing out this week. That usually means it is quiet, not that something is wrong.',
    },
  ]

  const briefing = buildBriefing(overview)

  const maturity: TodayMaturity | null =
    overview.couples.total < MATURITY_THRESHOLD_COUPLES
      ? {
          current: overview.couples.total,
          threshold: MATURITY_THRESHOLD_COUPLES,
          unit: 'couples',
          unlocks: 'patterns across your enquiries, like which listing sites send couples who book',
        }
      : null

  const pulseRows: TodayPulseRow[] = pulse.slice(0, PULSE_ROWS).map((p) => ({
    id: p.id,
    title: p.title,
    body: p.body,
    href: p.href,
    urgency: URGENCY[p.priority] ?? 'For information',
    when: agoPhrase(p.createdAt, now),
  }))

  return {
    briefing: briefing.text,
    briefingIsReason: briefing.isReason,
    blocks,
    pulse: pulseRows,
    maturity,
    allClear: blocks.every((b) => b.count === 0),
    asAt: dayLabel(daily.generatedAt, timeZone),
  }
}
