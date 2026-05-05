/**
 * POST /api/intel/cultural-moments/auto-propose
 *
 * Coordinator-facing trigger that runs the search-trends spike
 * detector and proposes any qualifying spikes as cultural moments
 * (status='proposed', proposed_by='ai'). The proposed rows show up
 * in the existing /intel/cultural-moments review queue.
 *
 * Cron-ready: when wired into a daily cron, scope='all' iterates
 * every venue with a metro. Authenticated coordinator (no scope)
 * runs only their venue.
 *
 * Auth: getPlatformAuth — coordinator must be signed in. No demo
 * mode bypass since this writes shared cultural_moments rows.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { autoProposeFromTrendSpikes } from '@/lib/services/insights/cultural-moments-auto-propose'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

export async function POST(request: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const scope = request.nextUrl.searchParams.get('scope') ?? 'venue'

  // Build the venueId list. 'venue' = caller's own venue (default).
  // 'all' = sweep every venue with a google_trends_metro set; ADMIN-
  // GATED because cross-tenant writes (cultural_moments rows
  // dedup'd at (term, weekStart) across all venues) must not be
  // initiable by any signed-in coordinator. Pre-fix any coordinator
  // could `?scope=all` and effectively claim auto-proposal slots
  // platform-wide. T3 review P0 #3.
  let venueIds: string[]
  if (scope === 'all') {
    if (auth.role !== 'org_admin' && auth.role !== 'super_admin') {
      return NextResponse.json({ error: 'forbidden_scope_all' }, { status: 403 })
    }
    const { data } = await supabase
      .from('venues')
      .select('id')
      .not('google_trends_metro', 'is', null)
    venueIds = ((data ?? []) as Array<{ id: string }>).map((v) => v.id)
  } else {
    venueIds = [auth.venueId]
  }

  const summary = {
    venuesChecked: venueIds.length,
    spikesDetected: 0,
    proposed: 0,
    deduped: 0,
    errors: 0,
    perVenue: [] as Array<{
      venueId: string
      spikesDetected: number
      proposed: number
      deduped: number
      errors: number
    }>,
  }

  for (const vid of venueIds) {
    const r = await autoProposeFromTrendSpikes(supabase, vid)
    summary.spikesDetected += r.spikesDetected
    summary.proposed += r.proposed
    summary.deduped += r.deduped
    summary.errors += r.errors
    summary.perVenue.push({
      venueId: vid,
      spikesDetected: r.spikesDetected,
      proposed: r.proposed,
      deduped: r.deduped,
      errors: r.errors,
    })
  }

  return NextResponse.json(summary)
}
