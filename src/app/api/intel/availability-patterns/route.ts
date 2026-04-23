import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import {
  computeAvailabilityPatterns,
  deriveTopAvailabilityInsight,
  type MonthlyFillRate,
} from '@/lib/services/quality-signals'

/**
 * GET /api/intel/availability-patterns
 *
 * Phase 4 Task 42. Returns per-venue monthly fill-rate data over the
 * next 12 months plus a derived headline insight (e.g. "Your September
 * Saturdays are filling 3x faster than October Saturdays").
 *
 * Query params (all optional):
 *   ?venue_id=UUID     — single venue (defaults to auth.venueId)
 *   ?group_id=UUID     — every venue in this venue_group
 *   ?org_id=UUID       — every venue in this organisation
 *
 * Response:
 *   { rows: Array<{
 *       venueId, venueName,
 *       next12Months: MonthlyFillRate[],
 *       saturdaysNext12Months: MonthlyFillRate[],
 *       topInsight: string | null,
 *   }> }
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

    // ---- Fetch venue names for labeling ----
    const { data: venueRows } = await service
      .from('venues')
      .select('id, name')
      .in('id', venueIds)
    const venueNameById = new Map<string, string>()
    for (const v of venueRows ?? []) {
      venueNameById.set(v.id as string, (v.name as string) ?? '')
    }

    // ---- Compute patterns per venue (parallel) ----
    const rows = await Promise.all(
      venueIds.map(async (vid) => {
        const patterns = await computeAvailabilityPatterns(vid)
        const topInsight = deriveTopAvailabilityInsight(patterns)
        return {
          venueId: vid,
          venueName: venueNameById.get(vid) ?? '',
          next12Months: patterns.next12Months as MonthlyFillRate[],
          saturdaysNext12Months: patterns.saturdaysNext12Months as MonthlyFillRate[],
          topInsight,
        }
      })
    )

    return NextResponse.json({ rows })
  } catch (err) {
    console.error('[api/intel/availability-patterns] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
