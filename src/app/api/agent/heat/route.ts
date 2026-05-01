import { NextRequest, NextResponse } from 'next/server'
import {
  getLeaderboard,
  getHeatDistribution,
  recordEngagementEvent,
  applyDailyDecay,
} from '@/lib/services/heat-mapping'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — Heat leaderboard + distribution
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
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
//   Body: { weddingId: string, eventType: string, direction?: 'inbound'|'outbound', metadata?: object }
//
// Defaults direction to 'inbound' — this endpoint is used by the
// admin / coordinator UI to manually log a couple-side action that
// Bloom didn't auto-detect (couple texted us, called, showed up, etc.).
// Outbound recording goes through the autonomous-sender / draft path,
// not this endpoint. INV-13.
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { weddingId, eventType, metadata, direction } = body

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

    const dir: 'inbound' | 'outbound' =
      direction === 'outbound' ? 'outbound' : 'inbound'

    const result = await recordEngagementEvent(
      auth.venueId,
      weddingId,
      eventType,
      dir,
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
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const summary = await applyDailyDecay(auth.venueId)

    return NextResponse.json({
      success: true,
      decayedCount: summary.decayedCount,
      warningsFired: summary.warningsFired,
      autoLostCount: summary.autoLostCount,
    })
  } catch (err) {
    console.error('[api/agent/heat] PATCH error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
