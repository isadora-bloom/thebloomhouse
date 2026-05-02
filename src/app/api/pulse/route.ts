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
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, isDemoMode } from '@/lib/api/auth-helpers'
import { aggregatePulse } from '@/lib/services/pulse-aggregator'

const DEMO_VENUE_ID = '22222222-2222-2222-2222-222222222201'

export async function GET(request: NextRequest) {
  const supabase = createServiceClient()
  const demo = await isDemoMode()

  let venueId: string
  if (demo) {
    venueId = request.nextUrl.searchParams.get('venueId') ?? DEMO_VENUE_ID
  } else {
    const auth = await getPlatformAuth()
    if (!auth) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    venueId = auth.venueId
  }

  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '50')
  const sinceDays = Number(request.nextUrl.searchParams.get('sinceDays') ?? '14')

  const items = await aggregatePulse(supabase, venueId, {
    limit: Number.isFinite(limit) && limit > 0 ? Math.min(200, limit) : 50,
    sinceDays: Number.isFinite(sinceDays) && sinceDays > 0 ? Math.min(60, sinceDays) : 14,
  })

  return NextResponse.json({ venueId, items, count: items.length })
}
