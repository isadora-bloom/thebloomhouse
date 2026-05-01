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

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const scope = request.nextUrl.searchParams.get('scope') ?? 'venue'

  // Build the venueId list. 'venue' = caller's own venue (default).
  // 'all' = sweep every venue with a google_trends_metro set.
  // 'all' is admin-gated when wired into UI; cron uses a service-
  // role bearer that bypasses getPlatformAuth, but that path goes
  // through a separate cron route (not this endpoint).
  let venueIds: string[]
  if (scope === 'all') {
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
