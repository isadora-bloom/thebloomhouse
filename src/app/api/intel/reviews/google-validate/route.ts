/**
 * POST /api/intel/reviews/google-validate
 *
 * TIER 7+ (2026-05-14). Validates a Google Place ID by hitting the v1
 * Place Details endpoint with a minimal field mask. Powers the "Test"
 * button on /settings/venue-info so operators can confirm they pasted
 * the correct ID before the weekly cron starts polling against it.
 *
 * Returns the venue's display name + formatted address so the operator
 * can visually confirm "yes that's my place". Does NOT write anything.
 *
 * Auth: requirePlan (any plan) + getPlatformAuth. Body: {place_id}.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { validateGooglePlaceId } from '@/lib/services/reviews/google-places'

export async function POST(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { place_id?: string }
  try {
    body = (await req.json()) as { place_id?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  if (!body.place_id || typeof body.place_id !== 'string') {
    return NextResponse.json({ error: 'place_id is required' }, { status: 400 })
  }

  const result = await validateGooglePlaceId(body.place_id)
  return NextResponse.json(result, { status: result.ok ? 200 : 400 })
}
