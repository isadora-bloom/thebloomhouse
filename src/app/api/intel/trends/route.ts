import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  detectTrendDeviations,
  fetchTrendsForVenue,
} from '@/lib/services/trends'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// GET — Recent trends + deviations for the authenticated user's venue
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const venueIds = await resolveScopeVenueIds()
    if (venueIds.length === 0) return NextResponse.json({ trends: [], deviations: [] })

    const supabase = await createServerSupabaseClient()

    // Last 8 weeks of trend data across every venue in scope. At
    // venue-level this is just the caller's venue; at company-level
    // we fold every venue's search_trends into one series so the
    // aggregate view doesn't silently drop the other venues' data.
    const eightWeeksAgo = new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const { data: trends, error } = await supabase
      .from('search_trends')
      .select('*')
      .in('venue_id', venueIds)
      .gte('week', eightWeeksAgo)
      .order('week', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    // Deviation detector is per-venue by design. At company/group
    // scope, fan out and concat — each deviation carries a venue_id
    // so the client can label it appropriately.
    const deviationsBatches = await Promise.all(
      venueIds.map((vid) => detectTrendDeviations(vid))
    )
    const deviations = deviationsBatches.flat()

    return NextResponse.json({ trends: trends ?? [], deviations })
  } catch (err) {
    console.error('[api/intel/trends] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Trigger a manual trend refresh for the venue
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const rowsUpserted = await fetchTrendsForVenue(auth.venueId)
    return NextResponse.json({ success: true, rowsUpserted })
  } catch (err) {
    console.error('[api/intel/trends] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
