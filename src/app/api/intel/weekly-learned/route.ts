import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { computeWeeklyLearned } from '@/lib/services/weekly-learned'

/**
 * GET /api/intel/weekly-learned
 *
 * Phase 5 Task 50. Returns the three-bullet "what your AI learned this
 * week" payload for the dashboard card.
 *
 * Query params (optional):
 *   ?venue_id=UUID  (defaults to auth.venueId)
 *
 * Gated behind the `intelligence` plan tier.
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) {
    return NextResponse.json(planErrorBody(plan), { status: plan.status })
  }

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const venueIdParam = request.nextUrl.searchParams.get('venue_id')
  const venueId = venueIdParam ?? auth.venueId

  if (!venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  try {
    const data = await computeWeeklyLearned(venueId)
    return NextResponse.json(data)
  } catch (err) {
    console.error('[api/intel/weekly-learned] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
