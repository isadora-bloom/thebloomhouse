/**
 * GET /api/intel/reviews/analytics
 *
 * TIER 7b (2026-05-14). Returns the venue's reviews rollup for the
 * dashboard panel: totals, source breakdown, monthly trend, sentiment
 * trajectory, top themes.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { computeReviewsAnalytics } from '@/lib/services/intel/reviews-analytics'

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rollup = await computeReviewsAnalytics(auth.venueId)
    return NextResponse.json({ rollup })
  } catch (err) {
    console.error('[reviews/analytics]', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to compute analytics' },
      { status: 500 },
    )
  }
}
