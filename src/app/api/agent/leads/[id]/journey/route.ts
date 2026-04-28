import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getWeddingJourney } from '@/lib/services/wedding-journey'

/**
 * GET /api/agent/leads/[id]/journey
 *
 * Returns the chronological journey for one wedding: touchpoints,
 * communication, AI drafts, engagement signals, status changes,
 * identity merges, tangential matches, and milestones, all merged and
 * deduped.
 *
 * Auth: caller must be authenticated to a venue. The journey service
 * verifies the wedding belongs to that venue before reading anything,
 * so a stale weddingId from another venue returns an empty list, not
 * cross-venue data.
 */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: weddingId } = await context.params
  if (!weddingId) {
    return NextResponse.json({ error: 'Missing wedding id' }, { status: 400 })
  }

  try {
    const events = await getWeddingJourney(auth.venueId, weddingId)
    return NextResponse.json({ events })
  } catch (err) {
    console.error('[api/agent/leads/[id]/journey]', err)
    return NextResponse.json(
      { error: 'Failed to load journey' },
      { status: 500 }
    )
  }
}
