/**
 * Canonical reader endpoint — getDailyList + getVenueOverview, scope-aware.
 *
 * Returns both readers in one call because the surfaces that want the
 * daily triage rail (/agent/leads, /agent/pipeline) always want the
 * lifecycle counts and the data-maturity `n` alongside it: a bucket
 * count with no sample size behind it is exactly the kind of unsourced
 * number the honesty doctrine forbids.
 *
 * GET → { ok, daily, overview, venueIds, venueCount, truncated }
 */

import { NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { createServiceClient } from '@/lib/supabase/service'
import { getDailyList, getVenueOverview } from '@/lib/intel/canonical'
import {
  emptyDailyList,
  emptyVenueOverview,
  mergeDailyLists,
  mergeVenueOverviews,
} from '@/lib/intel/adapters/scope-merge'

export const maxDuration = 60

const MAX_VENUES = 12

/**
 * Last real activity per wedding, from the spine.
 *
 * /agent/leads used to derive this from MAX(interactions.timestamp),
 * which was already a fix for an earlier bug (weddings.updated_at gets
 * bumped by every batch import, so every row showed today). The spine
 * answers the same question from `touchpoints`, which is the table that
 * now receives every channel — including the ones `interactions` never
 * carried. Keyed by wedding id because the leads table is still
 * wedding-keyed; the join is couples.source_wedding_id.
 */
async function loadLastActivityByWedding(
  venueIds: string[],
): Promise<Record<string, string>> {
  if (venueIds.length === 0) return {}
  const service = createServiceClient()

  const { data: coupleRows } = await service
    .from('couples')
    .select('id, source_wedding_id')
    .in('venue_id', venueIds)
    .not('source_wedding_id', 'is', null)
    .is('merged_into_id', null)
    .limit(20000)
  const weddingByCouple = new Map<string, string>()
  for (const c of (coupleRows ?? []) as Array<{
    id: string
    source_wedding_id: string | null
  }>) {
    if (c.source_wedding_id) weddingByCouple.set(c.id, c.source_wedding_id)
  }
  if (weddingByCouple.size === 0) return {}

  const { data: tpRows } = await service
    .from('touchpoints')
    .select('couple_id, occurred_at')
    .in('venue_id', venueIds)
    .not('couple_id', 'is', null)
    .order('occurred_at', { ascending: false })
    .limit(50000)

  const out: Record<string, string> = {}
  for (const t of (tpRows ?? []) as Array<{
    couple_id: string | null
    occurred_at: string
  }>) {
    if (!t.couple_id) continue
    const weddingId = weddingByCouple.get(t.couple_id)
    if (!weddingId) continue
    // Rows arrive newest-first, so the first hit per wedding wins.
    if (!(weddingId in out)) out[weddingId] = t.occurred_at
  }
  return out
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const allIds = await resolveScopeVenueIds()
  if (allIds.length === 0) {
    return NextResponse.json({
      ok: true,
      daily: emptyDailyList(),
      overview: emptyVenueOverview(),
      lastActivityByWedding: {},
      venueIds: [],
      venueCount: 0,
      truncated: false,
    })
  }
  const venueIds = allIds.slice(0, MAX_VENUES)

  try {
    const [dailyParts, overviewParts, lastActivityByWedding] = await Promise.all([
      Promise.all(venueIds.map((id) => getDailyList(id))),
      Promise.all(venueIds.map((id) => getVenueOverview(id))),
      loadLastActivityByWedding(venueIds),
    ])
    return NextResponse.json({
      ok: true,
      daily: mergeDailyLists(dailyParts),
      overview: mergeVenueOverviews(overviewParts),
      lastActivityByWedding,
      venueIds,
      venueCount: allIds.length,
      truncated: allIds.length > venueIds.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intel/canonical/daily-list] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
