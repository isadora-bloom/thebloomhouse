/**
 * GET /api/intel/weather
 *
 * TIER 6 (2026-05-14). Composes the 14-day forecast with upcoming tours
 * and weddings so the operator can see at a glance which dates are at
 * risk. Pure read; the forecast itself is refreshed by the nightly
 * Open-Meteo cron.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { computeWeatherIntelOverlay } from '@/lib/services/intel/weather-overlay'

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const overlay = await computeWeatherIntelOverlay(auth.venueId)
    return NextResponse.json({ overlay })
  } catch (err) {
    console.error('[weather] overlay failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to compute overlay' },
      { status: 500 },
    )
  }
}
