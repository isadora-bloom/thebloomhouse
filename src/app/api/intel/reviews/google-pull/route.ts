/**
 * POST /api/intel/reviews/google-pull
 *
 * TIER 7+ (2026-05-14). Operator-triggered immediate poll of the
 * venue's google_place_id. Removes the "wait until Monday 04:00 UTC"
 * pain when an operator first sets a Place ID. The weekly cron still
 * handles ongoing refresh; this endpoint is for first-run and
 * on-demand re-pulls.
 *
 * Auth: requirePlan + getPlatformAuth (scope-aware via auth.venueId).
 * Dedupe: same (venue_id, source='google', source_review_id) check as
 * the cron path — clicking the button twice is safe.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { pollGooglePlacesForVenue } from '@/lib/services/reviews/google-places'

export async function POST(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const result = await pollGooglePlacesForVenue(auth.venueId)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
