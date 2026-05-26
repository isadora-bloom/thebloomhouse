/**
 * GET /api/admin/identity/recent-merges
 *
 * Powers the "Recent merges" digest on /intel/identity-review. Returns
 * a unioned, time-ordered list of recent `couple_merge_events` (merge
 * types only — reject / unmerge are excluded) plus recent
 * `person_merges` rows for the caller's venue.
 *
 * Query string
 * ------------
 *   ?window_hours=72  default 72; clamped to [1, 168] (one week max).
 *   ?limit=100        default 100; clamped to [1, 200].
 *
 * Returns
 * -------
 *   200 { ok: true, page: RecentMergesPage }
 *   401 unauthenticated
 *   500 internal
 *
 * Multi-venue safe — every read filters on auth.venueId.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { loadRecentMerges } from '@/lib/services/identity/recent-merges'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }

  const url = new URL(req.url)
  const rawHours = url.searchParams.get('window_hours')
  const rawLimit = url.searchParams.get('limit')

  const windowHours = Math.min(
    168,
    Math.max(1, rawHours ? Number.parseInt(rawHours, 10) || 72 : 72),
  )
  const limit = Math.min(
    200,
    Math.max(1, rawLimit ? Number.parseInt(rawLimit, 10) || 100 : 100),
  )

  const supabase = createServiceClient()
  try {
    const page = await loadRecentMerges(supabase, auth.venueId, {
      windowHours,
      limit,
    })
    return NextResponse.json({ ok: true, page })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    )
  }
}
