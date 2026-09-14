/**
 * Canonical reader endpoint — the lead board.
 *
 * /agent/leads and /agent/pipeline both render from this one call, so a
 * couple cannot be hot on one page and cold on the other, or sit in
 * "Toured" on the board while the list still calls it an inquiry. The
 * work happens in `src/lib/intel/readers/lead-board.ts` (the spine read)
 * and `src/lib/intel/adapters/lead-board-view.ts` (the derivation). This
 * file is scope, auth and JSON.
 *
 * GET → { ok, rows, venueIds, venueCount, heatAvailable,
 *         unattachedFragments, truncated, warnings, generatedAt }
 *
 * `rows` are the reader's spine rows, not finished cards: the stage and
 * the heat words are derived on the client by the adapter so the two
 * pages run the same pure function over the same input and cannot drift
 * by rendering different fields of a pre-baked shape.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { getLeadBoard } from '@/lib/intel/readers/lead-board'

export const maxDuration = 60

/** Same cap the daily-list route uses, for the same reason: past a dozen
 *  venues this is a report, not a board. */
const MAX_VENUES = 12

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const allIds = await resolveScopeVenueIds()
  if (allIds.length === 0) {
    return NextResponse.json({
      ok: true,
      rows: [],
      venueIds: [],
      venueCount: 0,
      heatAvailable: true,
      unattachedFragments: null,
      truncated: false,
      warnings: [],
      generatedAt: new Date().toISOString(),
    })
  }
  const venueIds = allIds.slice(0, MAX_VENUES)

  try {
    const board = await getLeadBoard(venueIds)
    return NextResponse.json({
      ok: true,
      ...board,
      venueCount: allIds.length,
      truncated: board.truncated || allIds.length > venueIds.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intel/canonical/lead-board] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
