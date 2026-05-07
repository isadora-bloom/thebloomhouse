import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getReEngagementQueue, setReEngagementEnabled } from '@/lib/services/re-engagement'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

/**
 * GET /api/intel/reengagement
 *   Returns { enabled, candidates[], already_actioned }. When the
 *   venue hasn't opted in, candidates is empty and the page renders
 *   the opt-in CTA instead.
 *
 * POST /api/intel/reengagement  body={ enabled: boolean }
 *   Toggles the venue-level opt-in flag.
 */
export async function GET(req: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'solo')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sb = createServiceClient()
  try {
    const queue = await getReEngagementQueue(sb, auth.venueId)
    return NextResponse.json(queue)
  } catch (err) {
    console.error('[api/intel/reengagement GET]', err)
    return NextResponse.json({ error: 'Failed to load queue' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  const plan = await requirePlan(req, 'solo')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const body = await req.json().catch(() => ({})) as { enabled?: unknown }
  const enabled = body.enabled === true
  const sb = createServiceClient()
  try {
    await setReEngagementEnabled(sb, auth.venueId, enabled)
    return NextResponse.json({ enabled })
  } catch (err) {
    console.error('[api/intel/reengagement POST]', err)
    return NextResponse.json({ error: 'Failed to update setting' }, { status: 500 })
  }
}
