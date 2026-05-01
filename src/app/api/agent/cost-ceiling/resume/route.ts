import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { resumeAutonomousBehavior } from '@/lib/services/cost-ceiling'

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
//
// REST split out from /api/agent/cost-ceiling per Repair N — the parent
// route handles GET (status); resume is its own subroute. Self-review
// of T0-5 (392fe32) flagged the both-on-one-handler shape as
// non-idiomatic.
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
    auth.userId ?? 'unknown_coordinator',
  )

  if (!result.ok) {
    return NextResponse.json({ error: result.reason }, { status: 400 })
  }

  return NextResponse.json({ ok: true })
}
