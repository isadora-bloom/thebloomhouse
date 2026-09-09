/**
 * Daily-triage view — the four buckets an operator opens the app for.
 *
 * `/agent/leads` and `/agent/pipeline` each counted "hot leads" and
 * "going cold" for themselves, from `weddings` + `wedding_heat`, with
 * their own thresholds. Two pages, two answers, neither traceable to a
 * rule anyone had written down.
 *
 * `getDailyList` has the rule, and every threshold in it is sourced
 * (inbound action set from migration 348, decay window from decay.ts,
 * hot bar from heatBucket). This adapter turns that reader's output into
 * the rail both pages render, with the threshold text attached so the
 * operator can see WHY a couple is in a bucket, not just that it is.
 *
 * Pure. Unit-tested in ./__tests__/daily-list-view.test.ts.
 */

import type { CoupleRef, DailyList, VenueOverview } from '@/lib/intel/canonical'

export type TriageBucketKey =
  | 'needsReply'
  | 'goingCold'
  | 'toursThisWeek'
  | 'highIntent'

export interface TriageBucket {
  key: TriageBucketKey
  label: string
  count: number
  /** The rule that put couples in this bucket, in plain words. */
  rule: string
  /** Where the rule comes from, so it is auditable rather than magic. */
  source: string
  /** First few couples, for a hover / peek list. Never the whole set. */
  preview: CoupleRef[]
  /** What the surface says when the bucket is empty. Never "no data" —
   *  an empty needs-reply bucket is good news, not missing information. */
  emptyCopy: string
}

export interface TriageRail {
  buckets: TriageBucket[]
  /** Total live couples on the spine for this scope. */
  totalCouples: number
  /** Couples by lifecycle, straight from getVenueOverview. */
  byLifecycle: VenueOverview['couples']['byLifecycle']
  /** Total touchpoints behind every number on the rail. This is the `n`
   *  the honesty doctrine requires next to any aggregate. */
  touchpointCount: number
  /** Oldest touchpoint. An operator reading "3 going cold" deserves to
   *  know whether the history behind it is three years or three days. */
  oldestTouchpoint: string | null
  /** True when the spine has no touchpoints at all — the rail then leads
   *  with a data-maturity block rather than a row of zeros. */
  spineEmpty: boolean
  generatedAt: string
}

const PREVIEW_LIMIT = 5

export function buildTriageRail(
  daily: DailyList,
  overview: VenueOverview,
): TriageRail {
  const buckets: TriageBucket[] = [
    {
      key: 'needsReply',
      label: 'Waiting on us',
      count: daily.needsReply.length,
      rule:
        'The most recent thing that happened on this couple was them contacting us, and we have not answered since.',
      source:
        'getDailyList — inbound action set mirrors migration 348 §1, the same set that stamps last_progression_at. Booked and ghosted couples excluded.',
      preview: daily.needsReply.slice(0, PREVIEW_LIMIT),
      emptyCopy: 'Nobody is waiting on a reply. Every inbound has an answer after it.',
    },
    {
      key: 'goingCold',
      label: 'Going cold',
      count: daily.goingCold.length,
      rule:
        'Past three quarters of their decay window with no new signal, but not yet ghosted. Still recoverable.',
      source:
        'getDailyList — window arithmetic from decayStaleCouples (decay.ts); default window 120 days (migration 380).',
      preview: daily.goingCold.slice(0, PREVIEW_LIMIT),
      emptyCopy: 'No couple is drifting towards the end of its decay window.',
    },
    {
      key: 'toursThisWeek',
      label: 'Tours this week',
      count: daily.toursThisWeek.length,
      rule:
        'Scheduled in the next seven days, not cancelled and not a no-show, and resolvable to a couple on the spine.',
      source: 'getDailyList — tours table, joined to couples via source_wedding_id.',
      preview: [],
      emptyCopy: 'No tours booked in the next seven days.',
    },
    {
      key: 'highIntent',
      label: 'High intent',
      count: daily.highIntent.length,
      rule:
        'Heat at or above the hot bar of 60, ranked by heat, capped at ten.',
      source:
        'getDailyList — hot bar from heatBucket() in heat-score.ts; heat recomputed from touchpoints when the cached column is null.',
      preview: daily.highIntent.slice(0, PREVIEW_LIMIT),
      emptyCopy: 'No couple is above the hot bar right now.',
    },
  ]

  return {
    buckets,
    totalCouples: overview.couples.total,
    byLifecycle: overview.couples.byLifecycle,
    touchpointCount: overview.dataMaturity.n,
    oldestTouchpoint: overview.dataMaturity.oldestTouchpoint,
    spineEmpty: overview.dataMaturity.n === 0,
    generatedAt: daily.generatedAt,
  }
}

/** Couples that are in more than one bucket. Worth surfacing: a couple
 *  that is both waiting on a reply and going cold is the single most
 *  urgent row on the page, and neither bucket alone says so. */
export function urgentOverlap(daily: DailyList): CoupleRef[] {
  const cold = new Set(daily.goingCold.map((c) => c.id))
  return daily.needsReply.filter((c) => cold.has(c.id))
}
