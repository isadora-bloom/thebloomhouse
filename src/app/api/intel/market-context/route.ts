import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getMarketContext, benchmarkVenue } from '@/lib/services/market-context'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// GET — Market context + benchmarks for the authenticated user's venue
// Works EVEN with zero operational data (pre-loaded external data).
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const [context, comparisons] = await Promise.all([
      getMarketContext(auth.venueId),
      benchmarkVenue(auth.venueId),
    ])

    return NextResponse.json({
      market: context.market,
      benchmarks: context.benchmarks,
      comparisons,
      venueTier: context.venueTier,
      seasonalIndex: context.seasonalIndex,
      seasonalLabel: context.seasonalLabel,
    })
  } catch (err) {
    console.error('Market context error:', err)
    return NextResponse.json(
      { error: 'Failed to load market context' },
      { status: 500 }
    )
  }
}
