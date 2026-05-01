import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getCostCeilingStatus } from '@/lib/services/cost-ceiling'

// ---------------------------------------------------------------------------
// GET /api/agent/cost-ceiling
//
// Returns the venue's current spend vs ceiling and pause state. Used by
// admin UI / notifications to show a "you're at 84% of today's ceiling"
// banner without forcing the coordinator to query api_costs directly.
//
// To resume a paused venue, POST /api/agent/cost-ceiling/resume (subroute).
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!auth.venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  const status = await getCostCeilingStatus(auth.venueId)
  if (!status) {
    return NextResponse.json({ error: 'venue_config not found' }, { status: 404 })
  }

  return NextResponse.json({ status })
}
