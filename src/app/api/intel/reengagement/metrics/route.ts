import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getReEngagementMetrics } from '@/lib/services/re-engagement'

/**
 * GET /api/intel/reengagement/metrics
 * Returns drafted/sent/discarded/converted counts + conversion
 * rate. Cheap aggregate — read-only. Renders inside the source-
 * quality scorecard area on /intel/sources.
 */
export async function GET(_req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const sb = createServiceClient()
  try {
    const metrics = await getReEngagementMetrics(sb, auth.venueId)
    return NextResponse.json(metrics)
  } catch (err) {
    console.error('[api/intel/reengagement/metrics]', err)
    return NextResponse.json({ error: 'Failed to load metrics' }, { status: 500 })
  }
}
