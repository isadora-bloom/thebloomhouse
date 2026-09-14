import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  assertCanAccessVenue,
  unauthorized,
  forbidden,
  serverError,
} from '@/lib/api/auth-helpers'
import { generatePositioningSuggestions } from '@/lib/services/brain/intel-brain'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { redactError } from '@/lib/observability/redact'

// ---------------------------------------------------------------------------
// POST — Generate AI positioning suggestions for the venue
// Body: { venueId?: string } (optional override, defaults to auth venueId)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json().catch(() => ({}))
    const venueId = (body.venueId as string) || auth.venueId

    // The body could name any venue, and the suggestion generator reads
    // that venue's real positioning data as service role and bills an LLM
    // call for it. Check the caller can reach it before spending either.
    const decision = await assertCanAccessVenue(auth, venueId)
    if (!decision.ok) return forbidden(decision.reason)

    const result = await generatePositioningSuggestions(venueId)

    return NextResponse.json({
      suggestions: result.suggestions,
    })
  } catch (err) {
    console.error('[api/intel/positioning] POST error:', redactError(err))
    return serverError(err)
  }
}
