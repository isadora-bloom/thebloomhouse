import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { trackCoordinatorAction } from '@/lib/services/consultant-tracking'

/**
 * POST /api/tracking
 * Track a coordinator action (tour_booked, booking_closed, etc.)
 *
 * Body: { action: 'tour_booked' | 'booking_closed', venueId?: string }
 * Uses the authenticated user's venueId if not provided.
 */
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const action = body.action as string
    const venueId = (body.venueId as string) || auth.venueId

    const validActions = ['tour_booked', 'booking_closed', 'inquiry_handled']
    if (!validActions.includes(action)) {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }

    await trackCoordinatorAction(
      venueId,
      auth.userId,
      action as 'tour_booked' | 'booking_closed' | 'inquiry_handled'
    )

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[api/tracking] Error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
