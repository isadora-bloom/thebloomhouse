/**
 * The monthly story — one screen for the person who owns the venue.
 *
 * W52 of NOVEMBER-PLAN.md wave 7. Four numbers Bloom already computes,
 * on one page, in the order an owner asks about them: how fast we answer,
 * which tour days turn into bookings, what each channel costs and returns,
 * and whether the reviews are moving. Every one of them was already
 * derived somewhere in the product and none of them was ever collected
 * onto a single screen, so an owner had to visit four pages and hold four
 * numbers in their head to get one answer.
 *
 * Nothing here derives anything. Per INTEL-CANONICAL-API.md §1 the page is
 * a dumb renderer and this adapter is the thing between it and the
 * readers, so:
 *
 *   - response time is `mapCohortIntelToFunnel(...).responseTime`, the
 *     literal canonical mapping, so the number matches `getCohortFunnel`
 *     and therefore /intel/cohort and Ask your data;
 *   - the weekday tour table is `intel.funnel.byTourWeekday`, the table
 *     `computeFunnel` already built inside the same cohort build. It is
 *     read, not recomputed, so it matches the funnel-timing tab;
 *   - channels come from `getSourceAttribution` and are rendered through
 *     the existing `buildChannelTruthView`, so /intel/sources and this
 *     page cannot disagree;
 *   - reviews come from `computeReviewsAnalytics`, called with the
 *     injected client and otherwise untouched.
 *
 * One cohort build serves both the response time and the weekday table.
 * Building it twice would be two reads for two numbers that come out of
 * the same pass, and the two could drift by whatever arrived between
 * them.
 *
 * Three parts, the same shape as `since-last-here.ts`:
 *   1. `loadMonthlyStory` — injectable client, so the unit test drives it
 *      with a fake and no database.
 *   2. `getMonthlyStory` — the service-client wrapper the page calls.
 *   3. `buildMonthlyStoryView` — pure, turns the facts into the words on
 *      the screen. Unit-tested from hand-built facts.
 *
 * Honest empties throughout: a panel with nothing behind it says what is
 * missing and what would fill it. It never draws a zero.
 *
 * Pure builder unit-tested in ./__tests__/monthly-story.test.ts.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Distribution, SourceAttribution } from '@/lib/intel/canonical'
import type { FunnelSegment } from '@/lib/services/cohort/types'
import type { ReviewsAnalyticsRollup } from '@/lib/services/intel/reviews-analytics'
import { buildChannelTruthView, channelTruthHeadline, type ChannelTruthRow } from './channel-view'
import { WITHHELD, renderDistribution } from './honesty'
import { countPhrase } from '@/lib/copy/client-terms'

// ─────────────────────────────────────────────────────────────────────
// 1. Facts — what the readers returned
// ─────────────────────────────────────────────────────────────────────

/** A reader that failed is not the same as a reader that returned
 *  nothing, and the page says so differently. Each slice carries its own
 *  outcome so one outage cannot blank the whole screen. */
export type Slice<T> = { ok: true; value: T } | { ok: false; error: string }

export interface MonthlyStoryFacts {
  /** Median hours to first reply, canonical mapping. */
  responseTime: Slice<Distribution>
  /** Seven segments, Sunday first, exactly as `computeFunnel` built them.
   *  On this table `inquiries` has been overwritten with `toured` by the
   *  funnel itself, and `tourToBooked` is the answer. */
  weekdayTours: Slice<FunnelSegment[]>
  channels: Slice<SourceAttribution>
  reviews: Slice<ReviewsAnalyticsRollup>
  generatedAt: string
}

export interface MonthlyStoryOpts {
  /** ISO date. Passed straight through to the cohort builder's `since`. */
  since?: string | null
}

function failed(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/**
 * Read the four slices. The client is injected so the unit test can drive
 * this with a fake; `getMonthlyStory` below binds the service client.
 *
 * Every read is independent and every failure is caught, because an owner
 * opening this page during a reviews outage should still see the other
 * three numbers rather than an error card.
 */
export async function loadMonthlyStory(
  supabase: SupabaseClient,
  venueId: string,
  opts: MonthlyStoryOpts = {},
): Promise<MonthlyStoryFacts> {
  const generatedAt = new Date().toISOString()
  const emptyFacts: MonthlyStoryFacts = {
    responseTime: { ok: false, error: 'No venue in scope.' },
    weekdayTours: { ok: false, error: 'No venue in scope.' },
    channels: { ok: false, error: 'No venue in scope.' },
    reviews: { ok: false, error: 'No venue in scope.' },
    generatedAt,
  }
  if (!venueId) return emptyFacts

  const [{ mapCohortIntelToFunnel, getSourceAttribution }, { buildCohortIntel }, { computeReviewsAnalytics }] =
    await Promise.all([
      import('@/lib/intel/canonical'),
      import('@/lib/services/cohort'),
      import('@/lib/services/intel/reviews-analytics'),
    ])

  // One cohort build, two numbers off it.
  const cohort = await buildCohortIntel(supabase, venueId, { since: opts.since ?? null }).then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  )

  const [channelsResult, reviewsResult] = await Promise.all([
    getSourceAttribution(venueId).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
    computeReviewsAnalytics(venueId, supabase).then(
      (v) => ({ ok: true as const, v }),
      (e: unknown) => ({ ok: false as const, e }),
    ),
  ])

  const responseTime: Slice<Distribution> = cohort.ok
    ? { ok: true, value: mapCohortIntelToFunnel(cohort.v).responseTime }
    : { ok: false, error: failed(cohort.e) }

  const weekdayTours: Slice<FunnelSegment[]> = cohort.ok
    ? { ok: true, value: cohort.v.funnel.byTourWeekday }
    : { ok: false, error: failed(cohort.e) }

  return {
    responseTime,
    weekdayTours,
    channels: channelsResult.ok
      ? { ok: true, value: channelsResult.v }
      : { ok: false, error: failed(channelsResult.e) },
    reviews: reviewsResult.ok
      ? { ok: true, value: reviewsResult.v }
      : { ok: false, error: failed(reviewsResult.e) },
    generatedAt,
  }
}

/** Service-client wrapper. Dynamic import so the module stays importable
 *  from a client component, same as `canonical.ts` and `since-last-here`. */
export async function getMonthlyStory(
  venueId: string,
  opts: MonthlyStoryOpts = {},
): Promise<MonthlyStoryFacts> {
  const { createServiceClient } = await import('@/lib/supabase/service')
  return loadMonthlyStory(createServiceClient(), venueId, opts)
}

// ─────────────────────────────────────────────────────────────────────
// 2. The view model
// ─────────────────────────────────────────────────────────────────────

export type MonthlyStoryPanelKey = 'response-time' | 'tour-weekday' | 'channel-roi' | 'reviews'

export interface MonthlyStoryRow {
  key: string
  label: string
  /** Already formatted. The page prints it and does no maths of its own. */
  value: string
  /** One short line under the value, or null. */
  note: string | null
  /** True when the value is withheld and should be de-emphasised. */
  dim: boolean
  /** Marks the row worth the owner's eye. At most one per panel. */
  standout: boolean
}

export interface MonthlyStoryPanel {
  key: MonthlyStoryPanelKey
  title: string
  /** What this panel counts and how it decides. Always rendered, so a
   *  number never appears without the sentence that defines it. */
  blurb: string
  /** The one line an owner could read on its own. */
  headline: string
  /** False when `headline` is a reason rather than a finding. */
  isFinding: boolean
  rows: MonthlyStoryRow[]
  /** Warm, specific copy shown instead of rows when there are none. */
  empty: string | null
  /** Where the number comes from, auditable rather than magic. Named
   *  `provenance` rather than `source` because on a coordinator surface
   *  a field called `source` means the lead source, and the CI guard in
   *  scripts/check-source-rendering.mjs is right to say so. */
  provenance: string
  /** The deeper page this panel summarises. */
  href: string
  hrefLabel: string
}

export interface MonthlyStoryView {
  panels: MonthlyStoryPanel[]
  /** True when not one of the four panels has a finding behind it. */
  allEmpty: boolean
  generatedAt: string
}

/** The reporting floor this surface uses when it decides whether a
 *  weekday is worth naming. CHOSEN for this page: below five tours a
 *  weekday rate is one couple's decision wearing a percentage. The
 *  cohort readers carry no per-weekday floor of their own. */
export const MIN_TOURS_PER_WEEKDAY = 5

function percent(v: number): string {
  return `${Math.round(v * 100)}%`
}

function hoursPhrase(hours: number): string {
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60))
    return countPhrase(mins, 'minute')
  }
  if (hours < 48) return countPhrase(Math.round(hours), 'hour')
  return countPhrase(Math.round(hours / 24), 'day')
}

// — response time ————————————————————————————————————————————————————

function responseTimePanel(slice: Slice<Distribution>): MonthlyStoryPanel {
  const base = {
    key: 'response-time' as const,
    title: 'How fast you answer',
    blurb:
      'The middle of your first replies: half go out faster than this, half slower. Counted from the first message a couple sends that could be answered.',
    provenance: 'getCohortFunnel / mapCohortIntelToFunnel — responseTime, the same number /intel/cohort shows.',
    href: '/intel/cohort',
    hrefLabel: 'See the full response-time spread',
  }

  if (!slice.ok) {
    return {
      ...base,
      headline: 'Your response times would not load just now.',
      isFinding: false,
      rows: [],
      empty: 'Nothing is lost. Refresh, and if it keeps happening the alerts page will say what broke.',
    }
  }

  const rendered = renderDistribution(slice.value, 'number')
  if (!rendered.enoughData || slice.value.value === null) {
    return {
      ...base,
      headline:
        slice.value.n === 0
          ? 'No answered enquiries on record yet, so there is no reply speed to report.'
          : `Only ${countPhrase(slice.value.n, 'answered enquiry', 'answered enquiries')} so far. That is too few to call a typical reply speed.`,
      isFinding: false,
      rows: [],
      empty: 'A few more answered enquiries and this fills in on its own.',
    }
  }

  const hours = slice.value.value
  return {
    ...base,
    headline: `Your typical first reply goes out in ${hoursPhrase(hours)}.`,
    isFinding: true,
    rows: [
      {
        key: 'median',
        label: 'Typical first reply',
        value: hoursPhrase(hours),
        note: `Measured across ${countPhrase(slice.value.n, 'couple')}.`,
        dim: false,
        standout: true,
      },
    ],
    empty: null,
  }
}

// — weekday tour conversion ———————————————————————————————————————————

function weekdayPanel(slice: Slice<FunnelSegment[]>): MonthlyStoryPanel {
  const base = {
    key: 'tour-weekday' as const,
    title: 'Which tour days turn into bookings',
    blurb: `Of the couples who toured on each day, how many went on to book. Days with fewer than ${MIN_TOURS_PER_WEEKDAY} tours are shown but not rated.`,
    provenance: 'computeFunnel — byTourWeekday, the table the cohort funnel already builds. Read, not recomputed.',
    href: '/intel/cohort',
    hrefLabel: 'Open the funnel by weekday',
  }

  if (!slice.ok) {
    return {
      ...base,
      headline: 'Your tour days would not load just now.',
      isFinding: false,
      rows: [],
      empty: 'Nothing is lost. Refresh, and if it keeps happening the alerts page will say what broke.',
    }
  }

  const withTours = slice.value.filter((s) => s.toured > 0)
  if (withTours.length === 0) {
    return {
      ...base,
      headline: 'No tours on record yet, so there is nothing to split by day.',
      isFinding: false,
      rows: [],
      empty: 'Once tours start landing on the spine, the split by day appears here.',
    }
  }

  const rateable = withTours.filter((s) => s.toured >= MIN_TOURS_PER_WEEKDAY && s.tourToBooked !== null)
  const best = rateable.reduce<FunnelSegment | null>(
    (acc, s) => (acc === null || (s.tourToBooked as number) > (acc.tourToBooked as number) ? s : acc),
    null,
  )

  const rows: MonthlyStoryRow[] = withTours.map((s) => {
    const rated = s.toured >= MIN_TOURS_PER_WEEKDAY && s.tourToBooked !== null
    return {
      key: s.label,
      label: s.label,
      value: rated ? percent(s.tourToBooked as number) : WITHHELD,
      note: rated
        ? `${countPhrase(s.toured, 'tour')}, ${countPhrase(s.booked, 'booking')}`
        : `${countPhrase(s.toured, 'tour')} so far. Too few to put a rate on.`,
      dim: !rated,
      standout: best !== null && s.label === best.label,
    }
  })

  const headline = best
    ? `${best.label} tours book best: ${percent(best.tourToBooked as number)} of them go on to book.`
    : 'Tours are landing, but no single day has enough of them yet to name a best day.'

  return { ...base, headline, isFinding: best !== null, rows, empty: null }
}

// — channel ROI ———————————————————————————————————————————————————————

/** Channels shown before the list is capped. CHOSEN: five is what fits a
 *  390px screen without the panel becoming the page. The rest stay on
 *  /intel/sources, which is what the panel links to. */
export const CHANNELS_SHOWN = 5

function channelPanel(slice: Slice<SourceAttribution>): MonthlyStoryPanel {
  const base = {
    key: 'channel-roi' as const,
    title: 'What each channel returns',
    blurb:
      'Revenue back per pound of spend, under first touch. A channel with no spend recorded shows its couples but no return, because a return would be invented.',
    provenance: 'getSourceAttribution + buildChannelTruthView — the same rows /intel/sources renders.',
    href: '/intel/sources',
    hrefLabel: 'Open sources and ROI',
  }

  if (!slice.ok) {
    return {
      ...base,
      headline: 'Your channels would not load just now.',
      isFinding: false,
      rows: [],
      empty: 'Nothing is lost. Refresh, and if it keeps happening the alerts page will say what broke.',
    }
  }

  const view = buildChannelTruthView(slice.value)
  if (view.rows.length === 0) {
    return {
      ...base,
      headline: 'No channels credited yet.',
      isFinding: false,
      rows: [],
      empty: 'Once couples arrive with an acquisition touchpoint on them, the channels appear here.',
    }
  }

  const shown = view.rows.slice(0, CHANNELS_SHOWN)
  const rows: MonthlyStoryRow[] = shown.map((r: ChannelTruthRow) => ({
    key: r.channel,
    label: r.label,
    value: r.revenuePerDollar.text,
    note: r.revenuePerDollar.enoughData
      ? `${countPhrase(r.n, 'couple')}, ${r.cac.text} to win one`
      : `${countPhrase(r.n, 'couple')}. ${r.revenuePerDollar.reason ?? 'Not enough to put a return on.'}`,
    dim: r.revenuePerDollar.dim,
    standout: r.isConversionLeader,
  }))

  const anyReturn = shown.some((r) => r.revenuePerDollar.enoughData)
  return {
    ...base,
    headline: channelTruthHeadline(view),
    isFinding: anyReturn || view.sufficiency.anyEnough,
    rows,
    empty: null,
  }
}

// — review trend ——————————————————————————————————————————————————————

/** Months of review history the panel draws. CHOSEN: six is enough to see
 *  a direction and short enough to read at a glance. The rollup returns
 *  twenty-four. */
export const REVIEW_MONTHS_SHOWN = 6

const TREND_COPY: Record<'rising' | 'flat' | 'falling' | 'unknown', string> = {
  rising: 'Your reviews have been getting warmer over the last six months.',
  flat: 'Your reviews have held steady over the last six months.',
  falling: 'Your reviews have cooled over the last six months. Worth a read.',
  unknown: 'Not enough reviews on either side of the last six months to call a direction.',
}

function reviewsPanel(slice: Slice<ReviewsAnalyticsRollup>): MonthlyStoryPanel {
  const base = {
    key: 'reviews' as const,
    title: 'Where the reviews are going',
    blurb:
      'Average star rating by month, newest last, across every review source you have connected. A month with no reviews is shown as empty rather than as zero.',
    provenance:
      'computeReviewsAnalytics — monthly averages and the six-month sentiment direction, the same rollup /intel/reviews renders.',
    href: '/intel/reviews',
    hrefLabel: 'Open reviews',
  }

  if (!slice.ok) {
    return {
      ...base,
      headline: 'Your reviews would not load just now.',
      isFinding: false,
      rows: [],
      empty: 'Nothing is lost. Refresh, and if it keeps happening the alerts page will say what broke.',
    }
  }

  const r = slice.value
  if (r.total === 0) {
    return {
      ...base,
      headline: 'No reviews on file yet.',
      isFinding: false,
      rows: [],
      empty: 'Connect a review source, or paste a few in, and the trend starts building from that day.',
    }
  }

  const months = r.monthly.slice(-REVIEW_MONTHS_SHOWN)
  const rows: MonthlyStoryRow[] = months.map((m) => ({
    key: m.month,
    label: m.month,
    value: m.avg_rating === null ? WITHHELD : `${m.avg_rating.toFixed(1)}★`,
    note:
      m.count === 0
        ? 'No reviews that month.'
        : `${countPhrase(m.count, 'review')}${m.avg_sentiment === null ? '' : ', sentiment recorded'}`,
    dim: m.avg_rating === null,
    standout: false,
  }))

  const direction = r.sentiment_trend.direction
  const rating = r.avg_rating === null ? null : r.avg_rating.toFixed(1)
  const headline =
    rating === null
      ? TREND_COPY[direction]
      : `${rating}★ across ${countPhrase(r.total, 'review')}. ${TREND_COPY[direction]}`

  return { ...base, headline, isFinding: direction !== 'unknown' || rating !== null, rows, empty: null }
}

/**
 * Pure. Turns the four slices into the four panels the page renders.
 * Unit-tested with hand-built facts — no database, the same pattern as
 * `buildSinceLastHereStrip`.
 */
export function buildMonthlyStoryView(facts: MonthlyStoryFacts): MonthlyStoryView {
  const panels = [
    responseTimePanel(facts.responseTime),
    weekdayPanel(facts.weekdayTours),
    channelPanel(facts.channels),
    reviewsPanel(facts.reviews),
  ]
  return {
    panels,
    allEmpty: panels.every((p) => !p.isFinding),
    generatedAt: facts.generatedAt,
  }
}
