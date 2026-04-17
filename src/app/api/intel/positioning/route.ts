import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'
import { generatePositioningSuggestions } from '@/lib/services/intel-brain'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// POST — Generate AI positioning suggestions for the venue
// Body: { venueId?: string } (optional override, defaults to auth venueId)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json().catch(() => ({}))
    const venueId = (body.venueId as string) || auth.venueId

    const result = await generatePositioningSuggestions(venueId)

    return NextResponse.json({
      suggestions: result.suggestions,
    })
  } catch (err) {
    console.error('[api/intel/positioning] POST error:', err)
    return serverError(err)
  }
}
