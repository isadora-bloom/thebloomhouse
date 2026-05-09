/**
 * POST /api/admin/cultural-moments/archive-expired
 *
 * TRENDS-DIAGNOSIS Fix 1 follow-up (2026-05-09). One-shot manual
 * trigger of `archiveExpiredCulturalMoments`. Sibling of the daily
 * cron sub-step folded into runCulturalMomentsAutoPropose.
 *
 * Why this endpoint exists
 * ------------------------
 * The cron fires once per UTC morning. Cultural moments are a global
 * (cross-venue) table, so any venue waiting for cleanup has to wait
 * for the next 09:30 UTC tick. After Bug 2's broaden-the-sweep
 * change (now archives every status NOT IN ('archived','dismissed')
 * with end_at < now()), there's a backlog of historically-confirmed
 * Crestwood-era demo-seed rows (status='confirmed', end_at in 2025)
 * waiting to flip. This endpoint runs the same helper one time so a
 * coordinator can clear the backlog immediately.
 *
 * Auth: CRON_SECRET ONLY. The page-level read filter (Bug 1 fix)
 * already hides demo-seed rows from non-demo callers, so production
 * tenants don't actually see the unarchived rows in their UI — this
 * is an ops endpoint, not a coordinator-facing one. CRON_SECRET path
 * matches the pattern in 366ba4a (rebuild-names + cleanup-phantom-
 * partners): one auth path, body-supplied venueId optional.
 *
 * Body (optional): { venueId?: string }
 *   - venueId is purely informational (echoed back in the response)
 *     since archiveExpiredCulturalMoments runs against the global
 *     cultural_moments table — it's not venue-scoped. Documented
 *     here so the request shape matches the rebuild-names /
 *     cleanup-phantom-partners pattern even though the helper itself
 *     is global. Pass it for log-trail clarity.
 *
 * Returns:
 *   {
 *     ok: true,
 *     archivedCount: number,
 *     ids: string[],     // ids that flipped to status='archived'
 *     calledForVenueId: string | null,
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { archiveExpiredCulturalMoments } from '@/lib/services/external-context/cultural-moments'

export const maxDuration = 60

interface PostBody {
  venueId?: string
}

export async function POST(req: NextRequest) {
  const cronAuth = req.headers.get('authorization') === `Bearer ${process.env.CRON_SECRET}`
  if (!cronAuth) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  let body: PostBody = {}
  try {
    body = (await req.json()) as PostBody
  } catch {
    /* tolerate empty body */
  }
  const venueId = body.venueId ?? null

  const supabase = createServiceClient()
  try {
    const result = await archiveExpiredCulturalMoments(supabase)
    return NextResponse.json({
      ok: true,
      archivedCount: result.archivedCount,
      ids: result.ids,
      calledForVenueId: venueId,
    })
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'archive failed',
        calledForVenueId: venueId,
      },
      { status: 500 },
    )
  }
}
