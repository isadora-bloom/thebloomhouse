import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import {
  getCostCeilingStatus,
  resumeAutonomousBehavior,
} from '@/lib/services/cost-ceiling'

// ---------------------------------------------------------------------------
// GET /api/agent/cost-ceiling
//
// Returns the venue's current spend vs ceiling and pause state. Used by
// admin UI / notifications to show a "you're at 84% of today's ceiling"
// banner without forcing the coordinator to query api_costs directly.
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

// ---------------------------------------------------------------------------
// POST /api/agent/cost-ceiling/resume
//
// Coordinator override: clears autonomous_paused immediately. Used when
// the coordinator has investigated the spend driver, accepted the cost,
// and wants to resume autonomous behavior before the next UTC midnight
// natural reset.
//
// Records who triggered the override via admin_notifications type
// 'cost_ceiling_overridden' so the audit trail survives.
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!auth.venueId) {
    return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
  }

  const result = await resumeAutonomousBehavior(
    auth.venueId,
    auth.userId ?? 'unknown_coordinator'
  )

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
