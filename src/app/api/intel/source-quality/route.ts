import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import {
  computeSourceQuality,
  type SourceQualityRow,
} from '@/lib/services/source-quality'

/**
 * GET /api/intel/source-quality
 *
 * Phase 4 Task 39. Returns per-source quality metrics (avg revenue,
 * emails exchanged, portal activity, review score, referrals, friction
 * rate, time-to-book) for one or more venues in the requester's scope.
 *
 * Query params (all optional):
 *   ?venue_id=UUID         — single venue (defaults to auth.venueId)
 *   ?group_id=UUID         — every venue in this venue_group
 *   ?org_id=UUID           — every venue in this organisation
 *   ?aggregate=cross_venue — collapse the per-venue rows into one row
 *                            per source across the whole scope.
 *                            Coordinator at company scope wants
 *                            "Knot's avg booking value across all my
 *                            venues" — that's this.
 *
 * Response:
 *   { rows: Array<SourceQualityRow & { venueId, venueName }> }
 *
 * Gated behind the `intelligence` plan tier.
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = request.nextUrl.searchParams
  const venueIdParam = sp.get('venue_id')
  const groupIdParam = sp.get('group_id')
  const orgIdParam = sp.get('org_id')
  const aggregateMode = sp.get('aggregate') === 'cross_venue'

  const service = createServiceClient()

  try {
    // ---- Resolve target venue IDs based on scope ----
    let venueIds: string[] = []

    if (groupIdParam) {
      const { data: members } = await service
        .from('venue_group_members')
        .select('venue_id')
        .eq('group_id', groupIdParam)
      venueIds = (members ?? []).map((m) => m.venue_id as string)
    } else if (orgIdParam) {
      const { data: orgVenues } = await service
        .from('venues')
        .select('id')
        .eq('org_id', orgIdParam)
      venueIds = (orgVenues ?? []).map((v) => v.id as string)
    } else if (venueIdParam) {
      venueIds = [venueIdParam]
    } else {
      venueIds = [auth.venueId]
    }

    if (venueIds.length === 0) {
      return NextResponse.json({ rows: [] })
    }

    // ---- Fetch venue names in one pass for labeling rows ----
    const { data: venueRows } = await service
      .from('venues')
      .select('id, name')
      .in('id', venueIds)
    const venueNameById = new Map<string, string>()
    for (const v of venueRows ?? []) {
      venueNameById.set(v.id as string, (v.name as string) ?? '')
    }

    // ---- Compute quality rows per venue (parallel) ----
    const perVenue = await Promise.all(
      venueIds.map(async (vid) => {
        const rows = await computeSourceQuality(vid)
        return rows.map((r) => ({
          ...r,
          venueId: vid,
          venueName: venueNameById.get(vid) ?? '',
        }))
      })
    )

    const flat: Array<SourceQualityRow & { venueId: string; venueName: string }> =
      perVenue.flat()

    if (!aggregateMode) {
      return NextResponse.json({ rows: flat })
    }

    // ---- Cross-venue rollup ----
    // For each source, collapse the per-venue rows into a single row
    // weighted by bookedCount. Numerators/denominators recovered from
    // the per-venue averages so the aggregate represents the
    // population, not a mean-of-means.
    const bySource = new Map<string, {
      bookedCount: number
      revenueSum: number
      emailsSum: number
      portalSum: number
      reviewSum: number
      reviewCount: number
      referralCount: number
      frictionHits: number
      daysToBookSum: number
      daysToBookCount: number
      venuesContributing: Set<string>
    }>()
    for (const r of flat) {
      const a = bySource.get(r.source) ?? {
        bookedCount: 0,
        revenueSum: 0,
        emailsSum: 0,
        portalSum: 0,
        reviewSum: 0,
        reviewCount: 0,
        referralCount: 0,
        frictionHits: 0,
        daysToBookSum: 0,
        daysToBookCount: 0,
        venuesContributing: new Set<string>(),
      }
      a.bookedCount += r.bookedCount
      a.revenueSum += r.avgRevenue * r.bookedCount
      a.emailsSum += r.avgEmailsExchanged * r.bookedCount
      a.portalSum += r.avgPortalActivity * r.bookedCount
      if (r.avgReviewScore !== null) {
        // We don't have per-source review counts, so weight the avg by
        // bookedCount. Imprecise but consistent with the per-venue
        // computation. Coordinators at portfolio scope want the
        // population-weighted answer, not a mean-of-means.
        a.reviewSum += r.avgReviewScore * r.bookedCount
        a.reviewCount += r.bookedCount
      }
      a.referralCount += r.referralCount
      a.frictionHits += r.frictionRate * r.bookedCount
      if (r.avgDaysToBook !== null) {
        a.daysToBookSum += r.avgDaysToBook * r.bookedCount
        a.daysToBookCount += r.bookedCount
      }
      a.venuesContributing.add(r.venueId)
      bySource.set(r.source, a)
    }

    const rows = [...bySource.entries()].map(([source, a]) => ({
      source,
      bookedCount: a.bookedCount,
      avgRevenue: a.bookedCount > 0 ? a.revenueSum / a.bookedCount : 0,
      avgEmailsExchanged: a.bookedCount > 0 ? a.emailsSum / a.bookedCount : 0,
      avgPortalActivity: a.bookedCount > 0 ? a.portalSum / a.bookedCount : 0,
      avgReviewScore: a.reviewCount > 0 ? a.reviewSum / a.reviewCount : null,
      referralCount: a.referralCount,
      frictionRate: a.bookedCount > 0 ? a.frictionHits / a.bookedCount : 0,
      avgDaysToBook: a.daysToBookCount > 0 ? a.daysToBookSum / a.daysToBookCount : null,
      // venueId/venueName are slotted with sentinels so the UI can
      // distinguish a cross-venue row from a per-venue one.
      venueId: '__aggregate__',
      venueName: `${a.venuesContributing.size} venue${a.venuesContributing.size === 1 ? '' : 's'}`,
    }))
    rows.sort((a, b) => b.bookedCount - a.bookedCount)

    return NextResponse.json({ rows, aggregate: 'cross_venue' })
  } catch (err) {
    console.error('[api/intel/source-quality] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
