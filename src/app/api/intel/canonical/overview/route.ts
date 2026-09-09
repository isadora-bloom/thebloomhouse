/**
 * Canonical reader endpoint — getVenueOverview, scope-aware.
 *
 * The admin twin at /api/admin/intel/canonical/overview answers for
 * `auth.venueId` only. Coordinator surfaces run under a scope the
 * operator chose (venue / group / company), so this route resolves that
 * scope server-side with `resolveScopeVenueIds` — which validates the
 * group and the org before it returns anything — reads the canonical
 * function once per venue, and merges the results.
 *
 * Only additive fields are merged (counts, feeds, minimums). See
 * src/lib/intel/adapters/scope-merge.ts for why ratios are not.
 *
 * GET → { ok, overview, venueIds, venueCount, truncated }
 */

import { NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { getVenueOverview } from '@/lib/intel/canonical'
import { emptyVenueOverview, mergeVenueOverviews } from '@/lib/intel/adapters/scope-merge'

export const maxDuration = 60

/** Hard cap on the fan-out. A company-scope read across a hundred venues
 *  would be a hundred round trips; better to answer honestly for the
 *  first N and say so than to time out with nothing. */
const MAX_VENUES = 12

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const allIds = await resolveScopeVenueIds()
  if (allIds.length === 0) {
    return NextResponse.json({
      ok: true,
      overview: emptyVenueOverview(),
      venueIds: [],
      venueCount: 0,
      truncated: false,
    })
  }

  const venueIds = allIds.slice(0, MAX_VENUES)

  try {
    const parts = await Promise.all(venueIds.map((id) => getVenueOverview(id)))
    return NextResponse.json({
      ok: true,
      overview: mergeVenueOverviews(parts),
      venueIds,
      venueCount: allIds.length,
      truncated: allIds.length > venueIds.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intel/canonical/overview] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
