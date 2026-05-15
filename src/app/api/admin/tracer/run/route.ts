/**
 * POST /api/admin/tracer/run
 *
 * On-demand operator trigger for the Identity-First Phase B
 * Backwards Tracer. Operator presses "Run now" on the
 * /admin/tracer-runs page; this endpoint kicks a tracer run for
 * the caller's venue (or any venue if super_admin).
 *
 * Anchor: IDENTITY-FIRST-ARCHITECTURE.md §4 ("Tracer runs as a
 * Vercel cron-triggered background job") + Appendix A (Susan's
 * Day 0 scenario triggers Tracer on connect-channel, not just
 * on cron).
 *
 * Body
 * ----
 *   { venue_id?: string }         — defaults to auth.venueId
 *   { adapters?: string[] }       — subset filter, optional
 *   { run_id?: string }           — resume an existing run
 *   { since?: string }            — ISO timestamp, optional incremental
 *
 * Returns
 * -------
 *   200 { summary: TracerSummary }
 *   401 unauthorized | 403 forbidden | 500 error
 *
 * Cold-start: when the venue has zero booked-anchor couples, the
 * Tracer short-circuits with status='cold_start_needed'. The UI
 * uses this to prompt the operator to seed ground truth manually
 * (§4 Don't skip #4).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { runIdentityFirstTracerForVenue } from '@/lib/services/identity/tracer-runner'

export const maxDuration = 300

interface RunRequestBody {
  venue_id?: string
  adapters?: string[]
  run_id?: string
  since?: string | null
  judge_budget?: number
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = (await req.json().catch(() => ({}))) as RunRequestBody
  const role = (auth.role ?? 'coordinator') as string
  const isSuperOrOrg =
    auth.isDemo || role === 'super_admin' || role === 'org_admin'

  let targetVenueId = body.venue_id ?? auth.venueId ?? null
  if (!targetVenueId) {
    return NextResponse.json(
      { error: 'venue_id required (no venue in auth context)' },
      { status: 400 },
    )
  }

  // Coordinator/manager can only kick their own venue; super/org can
  // target any.
  if (!isSuperOrOrg && targetVenueId !== auth.venueId) {
    return NextResponse.json(
      { error: 'forbidden — only super_admin / org_admin can run other venues' },
      { status: 403 },
    )
  }

  try {
    const summary = await runIdentityFirstTracerForVenue(targetVenueId, {
      adapters: body.adapters,
      runId: body.run_id,
      since: body.since ?? null,
      judgeBudget: body.judge_budget,
    })
    return NextResponse.json({ summary })
  } catch (err) {
    return NextResponse.json(
      {
        error: 'tracer_failed',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
