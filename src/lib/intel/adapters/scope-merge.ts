/**
 * Scope merge — turning per-venue canonical reads into one answer for a
 * group or company scope.
 *
 * The six canonical readers are venue-scoped by design: the venue is the
 * tenancy boundary, so a reader that accepted a list of venues would be
 * a leak waiting to happen. Multi-venue surfaces therefore call the
 * reader once per venue (after an access check each time) and merge the
 * results here.
 *
 * The line this module holds: MERGE ONLY WHAT IS ADDITIVE.
 *
 *   - Counts add. A lifecycle count, a touchpoint count, a list of
 *     couples needing a reply: all exact under concatenation.
 *   - Ratios do NOT add. Conversion is weightedBooked / weightedCouples,
 *     and the canonical `Distribution` carries the rate and the couple
 *     count, not the numerator. Re-deriving a numerator from rate x n
 *     would be a fabricated number wearing a measured number's clothes.
 *
 * So there is deliberately no `mergeSourceAttribution` here. Multi-venue
 * channel truth is rendered per venue instead. See
 * src/app/api/intel/canonical/source-attribution/route.ts.
 *
 * Pure. Unit-tested in ./__tests__/scope-merge.test.ts.
 */

import type {
  ActivityItem,
  DailyList,
  LifecycleState,
  VenueOverview,
} from '@/lib/intel/canonical'

const RECENT_ACTIVITY_LIMIT = 12

const ZERO_LIFECYCLE: Record<LifecycleState, number> = {
  channel_scoped: 0,
  resolved: 0,
  booked: 0,
  completed: 0,
  ghost: 0,
  agent: 0,
}

/** Honest-empty overview. Returned when a scope resolves to no venues. */
export function emptyVenueOverview(generatedAt = new Date().toISOString()): VenueOverview {
  return {
    couples: { total: 0, byLifecycle: { ...ZERO_LIFECYCLE } },
    recentActivity: [],
    dataMaturity: { backfillStatus: 'unknown', oldestTouchpoint: null, n: 0 },
    generatedAt,
  }
}

/**
 * Sum venue overviews into one. Every field is additive or a min/max, so
 * the merged overview is exact, not an estimate.
 *
 *  - couples.total + byLifecycle : summed.
 *  - recentActivity              : concatenated, newest first, capped at
 *                                  the same 12 a single venue returns so
 *                                  the feed does not grow with the scope.
 *  - dataMaturity.n              : summed.
 *  - dataMaturity.oldestTouchpoint : earliest across venues.
 *  - backfillStatus              : 'populated' when any venue has data,
 *                                  'empty' when every venue is empty,
 *                                  'unknown' when there are no venues.
 */
export function mergeVenueOverviews(parts: readonly VenueOverview[]): VenueOverview {
  const generatedAt = new Date().toISOString()
  if (parts.length === 0) return emptyVenueOverview(generatedAt)
  if (parts.length === 1) return parts[0]

  const byLifecycle = { ...ZERO_LIFECYCLE }
  let total = 0
  let n = 0
  let oldest: string | null = null
  const activity: ActivityItem[] = []

  for (const p of parts) {
    total += p.couples.total
    for (const key of Object.keys(byLifecycle) as LifecycleState[]) {
      byLifecycle[key] += p.couples.byLifecycle[key] ?? 0
    }
    n += p.dataMaturity.n
    const o = p.dataMaturity.oldestTouchpoint
    if (o && (oldest === null || o < oldest)) oldest = o
    activity.push(...p.recentActivity)
  }

  activity.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))

  return {
    couples: { total, byLifecycle },
    recentActivity: activity.slice(0, RECENT_ACTIVITY_LIMIT),
    dataMaturity: {
      backfillStatus: n === 0 ? 'empty' : 'populated',
      oldestTouchpoint: oldest,
      n,
    },
    generatedAt,
  }
}

/** Honest-empty daily list. */
export function emptyDailyList(generatedAt = new Date().toISOString()): DailyList {
  return {
    needsReply: [],
    goingCold: [],
    toursThisWeek: [],
    highIntent: [],
    generatedAt,
  }
}

/**
 * Concatenate daily lists across venues. Each bucket is a list of rows
 * the reader already selected, so concatenation is exact for three of
 * the four.
 *
 * Caveat, stated rather than hidden: `highIntent` is capped at the top
 * ten PER VENUE inside the reader. A merged list is therefore the union
 * of per-venue top tens, not the global top ten across the group. For a
 * two-venue group that difference cannot bite until one venue has more
 * than ten couples above the hot bar; the surface says so rather than
 * pretending the ranking is global.
 */
export function mergeDailyLists(parts: readonly DailyList[]): DailyList {
  const generatedAt = new Date().toISOString()
  if (parts.length === 0) return emptyDailyList(generatedAt)
  if (parts.length === 1) return parts[0]

  const out = emptyDailyList(generatedAt)
  for (const p of parts) {
    out.needsReply.push(...p.needsReply)
    out.goingCold.push(...p.goingCold)
    out.toursThisWeek.push(...p.toursThisWeek)
    out.highIntent.push(...p.highIntent)
  }
  out.toursThisWeek.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
  return out
}
