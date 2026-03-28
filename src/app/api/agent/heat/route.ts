import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  getLeaderboard,
  getHeatDistribution,
  recordEngagementEvent,
  applyDailyDecay,
} from '@/lib/services/heat-mapping'

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

async function getAuthVenue() {
  const supabase = await createServerSupabaseClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('venue_id')
    .eq('id', user.id)
    .single()

  return profile?.venue_id
    ? { userId: user.id, venueId: profile.venue_id as string }
    : null
}

// ---------------------------------------------------------------------------
// GET — Heat leaderboard + distribution
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const [leaderboard, distribution] = await Promise.all([
      getLeaderboard(auth.venueId),
      getHeatDistribution(auth.venueId),
    ])

    return NextResponse.json({ leaderboard, distribution })
  } catch (err) {
    console.error('[api/agent/heat] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Record an engagement event
//   Body: { weddingId: string, eventType: string, metadata?: object }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { weddingId, eventType, metadata } = body

    if (!weddingId || typeof weddingId !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid weddingId' },
        { status: 400 }
      )
    }

    if (!eventType || typeof eventType !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid eventType' },
        { status: 400 }
      )
    }

    const result = await recordEngagementEvent(
      auth.venueId,
      weddingId,
      eventType,
      metadata
    )

    return NextResponse.json({ success: true, result })
  } catch (err) {
    console.error('[api/agent/heat] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// PATCH — Trigger daily decay (manual trigger)
// ---------------------------------------------------------------------------

export async function PATCH() {
  const auth = await getAuthVenue()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const decayedCount = await applyDailyDecay(auth.venueId)

    return NextResponse.json({ success: true, decayedCount })
  } catch (err) {
    console.error('[api/agent/heat] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
