/**
 * GET /api/pulse — unified pulse feed (ARCH-20.2.2).
 *
 * Aggregates admin_notifications + anomaly_alerts +
 * intelligence_insights into a single priority-sorted PulseItem[].
 * Backs the /pulse page; future top-bar drawer + home-pulse use the
 * same endpoint.
 *
 * Auth: getPlatformAuth — coordinator must be signed in.
 * Demo mode bypasses auth (matches /api/insights/lead pattern).
 */

import { NextRequest, NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { aggregatePulseFull } from '@/lib/services/intel/pulse-aggregator'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { verifyDemoToken, DEMO_TOKEN_COOKIE, DEMO_VENUE_ID } from '@/lib/services/demo-token'

export async function GET(request: NextRequest) {
  // GAP-12: API-layer plan_tier enforcement BEFORE any DB reads.
  // Pulse aggregates intelligence_insights + anomaly_alerts, both are
  // intelligence-tier features. Demo cookie path bypasses inside requirePlan.
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const supabase = createServiceClient()

  // GAP-C2: demo venueId must come from the verified signed token, never from
  // the query param. A demo-authenticated user passing ?venueId=<real-uuid>
  // would otherwise read any venue's pulse data for free.
  const cookieStore = await cookies()
  const demoResult = verifyDemoToken(cookieStore.get(DEMO_TOKEN_COOKIE)?.value)

  let venueId: string
  if (demoResult.ok) {
    // Locked to the venue embedded in the verified token — query param ignored.
    venueId = DEMO_VENUE_ID
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    // auth.venueId is read from the user's DB profile — the query param is
    // never consulted for non-demo coordinators either.
    venueId = auth.venueId
  }

  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '50')
  const sinceDays = Number(request.nextUrl.searchParams.get('sinceDays') ?? '14')

  const { items, pausedBanner } = await aggregatePulseFull(supabase, venueId, {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(200, limit) : 50,
    sinceDays: Number.isFinite(sinceDays) && sinceDays > 0 ? Math.min(60, sinceDays) : 14,
  })

  return NextResponse.json({
    venueId,
    items,
    count: items.length,
    pausedBanner,
  })
}
