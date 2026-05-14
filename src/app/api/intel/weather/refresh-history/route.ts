/**
 * POST /api/intel/weather/refresh-history
 *
 * Operator-triggered refresh of the climate-norms + anomaly-events
 * data for the current venue. Fetches 20 years of hourly archive
 * data from Open-Meteo, aggregates locally, replaces both tables.
 *
 * The fetch + aggregate runs in ~5-15 seconds for most venues, so we
 * inline it here. The Vercel function timeout (300s default on Fluid
 * Compute) gives plenty of headroom. If a future venue needs more,
 * we can push this to a background queue.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { backfillVenueClimateNorms } from '@/lib/services/intel/weather-climate-norms'

export async function POST(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const result = await backfillVenueClimateNorms(auth.venueId)
    return NextResponse.json({ ok: true, result })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Refresh failed'
    console.error('[weather/refresh-history]', msg)
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
