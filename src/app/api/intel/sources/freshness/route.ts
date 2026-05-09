import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { computeFreshnessReports } from '@/lib/services/intel/source-freshness'

/**
 * GET /api/intel/sources/freshness
 *
 * Returns the FreshnessReport[] for the caller's venue. Used by:
 *   - the banner on /intel/sources (to count `reminder_due`)
 *   - the badges on /intel/sources/track (to render last-upload-N-days-ago
 *     and the amber "needs an upload" pill)
 *
 * Pure read endpoint; no mutations. The cron at job=source_freshness is
 * what fires admin_notifications and stamps last_reminded_at.
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const reports = await computeFreshnessReports(auth.venueId)
    return NextResponse.json({ reports })
  } catch (err) {
    console.error('[GET /api/intel/sources/freshness] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to compute freshness' },
      { status: 500 },
    )
  }
}
