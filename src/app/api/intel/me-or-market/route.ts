import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { computeMeOrMarket } from '@/lib/services/me-or-market'

// ---------------------------------------------------------------------------
// GET /api/intel/me-or-market
//
// Phase 6 Task 55. Returns a plain-English diagnosis composing venue
// inquiry volume, regional search trends, economic sentiment, and
// availability fill into a single verdict.
//
// Gating: intelligence plan tier (matches every other /api/intel/* route).
// Scope: resolved via getPlatformAuth, same cookie path as benchmark.
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const diagnosis = await computeMeOrMarket(auth.venueId)
    return NextResponse.json({ diagnosis })
  } catch (err) {
    console.error('[me-or-market] Failed to compute diagnosis:', err)
    return NextResponse.json(
      { error: 'Failed to compute diagnosis' },
      { status: 500 }
    )
  }
}
