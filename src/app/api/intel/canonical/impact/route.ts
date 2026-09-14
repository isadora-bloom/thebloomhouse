/**
 * Canonical reader endpoint — everything /intel/roi ("Your Impact") puts
 * on screen, in one call, from the readers that own each number.
 *
 * Before this, the page built all six cards itself in the browser:
 * inbound `interactions` for inquiries, a hand-rolled inbound/outbound
 * pairing over `interactions` for response time, `weddings.booked_at`
 * for bookings and a sum of `weddings.booking_value` for pipeline. None
 * of it was shared with any other surface, so "how fast do we reply"
 * had one answer here, another on /intel/cohort and a third in Ask your
 * data.
 *
 * Now each number has exactly one owner:
 *   - inquiries + bookings, month over month → `loadVenueImpact`
 *   - live pipeline count                    → `getVenueOverview`
 *   - response time and its drop-off point   → `getCohortFunnel`
 *   - channel truth                          → the page renders
 *     `ChannelTruthSection`, which calls /api/intel/canonical/source-
 *     attribution, which calls `getSourceAttribution`. Same component,
 *     same endpoint and same reader as /intel/sources.
 *
 * Counts add across venues, so they are returned summed. Response time
 * is a median and medians do not add, so it comes back per venue and the
 * page prints one row each. Adding two medians produces a number nobody
 * measured, which is the whole reason this workstream exists.
 *
 * Draft counts are NOT spine facts. They are agent productivity, they
 * live on `drafts` / `draft_feedback`, and they are read here only so
 * the page itself holds no queries at all.
 *
 * GET → { ok, venueCount, truncated, totals, parts }
 */

import { NextRequest, NextResponse } from 'next/server'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { createServiceClient } from '@/lib/supabase/service'
import { getCohortFunnel, getVenueOverview, type CohortFunnel, type Distribution } from '@/lib/intel/canonical'
import { loadVenueImpact } from '@/lib/intel/readers/venue-impact'

export const maxDuration = 120

/** The cohort funnel walks every couple's ribbon, so the fan-out cap
 *  matches the attribution endpoint's rather than the overview's. */
const MAX_VENUES = 6

export interface ImpactPart {
  venueId: string
  venueName: string | null
  /** Median hours to first reply, with n and the honesty reason. */
  responseTime: Distribution
  /** The response-speed band after which the tour rate drops most.
   *  Null when no inflection point is detectable. */
  knee: CohortFunnel['knee']
}

export interface ImpactTotals {
  inquiries: { thisMonth: number; lastMonth: number }
  bookings: { thisMonth: number; lastMonth: number }
  /** Couples still live: channel-scoped plus resolved, not yet booked. */
  livePipelineCouples: number
  /** Touchpoints this month with no write-time direction stamp. Not
   *  counted as inquiries, reported so the gap is visible. */
  unstampedThisMonth: number
  draftsThisMonth: number
  draftsLastMonth: number
  feedbackTotal: number
  feedbackApproved: number
}

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const allIds = await resolveScopeVenueIds()
  const empty: ImpactTotals = {
    inquiries: { thisMonth: 0, lastMonth: 0 },
    bookings: { thisMonth: 0, lastMonth: 0 },
    livePipelineCouples: 0,
    unstampedThisMonth: 0,
    draftsThisMonth: 0,
    draftsLastMonth: 0,
    feedbackTotal: 0,
    feedbackApproved: 0,
  }
  if (allIds.length === 0) {
    return NextResponse.json({ ok: true, venueCount: 0, truncated: false, totals: empty, parts: [] })
  }
  const venueIds = allIds.slice(0, MAX_VENUES)

  try {
    const service = createServiceClient()

    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
    const lastMonthEnd = new Date(
      now.getFullYear(),
      now.getMonth(),
      0,
      23,
      59,
      59,
      999,
    ).toISOString()

    const [venueRows, perVenue, draftsThis, draftsLast, feedbackAll, feedbackApproved] =
      await Promise.all([
        service.from('venues').select('id, name').in('id', venueIds),
        Promise.all(
          venueIds.map(async (venueId) => {
            const [impact, overview, funnel] = await Promise.all([
              loadVenueImpact(service, venueId, { now }),
              getVenueOverview(venueId),
              getCohortFunnel(venueId),
            ])
            return { venueId, impact, overview, funnel }
          }),
        ),
        service
          .from('drafts')
          .select('id', { count: 'exact', head: true })
          .in('venue_id', venueIds)
          .gte('created_at', monthStart),
        service
          .from('drafts')
          .select('id', { count: 'exact', head: true })
          .in('venue_id', venueIds)
          .gte('created_at', lastMonthStart)
          .lte('created_at', lastMonthEnd),
        service
          .from('draft_feedback')
          .select('id', { count: 'exact', head: true })
          .in('venue_id', venueIds),
        service
          .from('draft_feedback')
          .select('id', { count: 'exact', head: true })
          .in('venue_id', venueIds)
          .eq('action', 'approved'),
      ])

    const nameById = new Map<string, string | null>(
      ((venueRows.data ?? []) as Array<{ id: string; name: string | null }>).map((v) => [
        v.id,
        v.name,
      ]),
    )

    const totals: ImpactTotals = {
      ...empty,
      draftsThisMonth: draftsThis.count ?? 0,
      draftsLastMonth: draftsLast.count ?? 0,
      feedbackTotal: feedbackAll.count ?? 0,
      feedbackApproved: feedbackApproved.count ?? 0,
    }
    const parts: ImpactPart[] = []

    for (const v of perVenue) {
      totals.inquiries.thisMonth += v.impact.inquiries.thisMonth
      totals.inquiries.lastMonth += v.impact.inquiries.lastMonth
      totals.bookings.thisMonth += v.impact.bookings.thisMonth
      totals.bookings.lastMonth += v.impact.bookings.lastMonth
      totals.unstampedThisMonth += v.impact.unstampedThisMonth
      totals.livePipelineCouples +=
        v.overview.couples.byLifecycle.channel_scoped + v.overview.couples.byLifecycle.resolved
      parts.push({
        venueId: v.venueId,
        venueName: nameById.get(v.venueId) ?? null,
        responseTime: v.funnel.responseTime,
        knee: v.funnel.knee,
      })
    }

    return NextResponse.json({
      ok: true,
      venueCount: parts.length,
      truncated: allIds.length > venueIds.length,
      totals,
      parts,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intel/canonical/impact] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
