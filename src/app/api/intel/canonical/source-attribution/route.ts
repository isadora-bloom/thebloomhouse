/**
 * Canonical reader endpoint — getSourceAttribution, scope-aware.
 *
 * This is the ONE server-side source of channel truth for the operator
 * surfaces. /intel/sources and /intel/attribution both fetch it, and
 * both render the result through buildChannelTruthView, so the two pages
 * cannot disagree about a conversion rate again.
 *
 * Multi-venue scope returns one attribution PER VENUE rather than a
 * merged one. Conversion is weightedBooked / weightedCouples and the
 * canonical Distribution carries the rate and the couple count, not the
 * numerator — so a merged rate could only ever be reconstructed, and a
 * reconstructed number that renders like a measured one is exactly what
 * this workstream exists to stop.
 *
 * GET ?model=first_touch|last_touch|linear|time_decay&sinceDays=N
 *   → { ok, model, parts: [{ venueId, venueName, attribution }], truncated }
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized } from '@/lib/api/auth-helpers'
import { resolveScopeVenueIds } from '@/lib/api/resolve-platform-scope'
import { createServiceClient } from '@/lib/supabase/service'
import { getSourceAttribution, type AttributionModel } from '@/lib/intel/canonical'

export const maxDuration = 120

const MODELS: AttributionModel[] = ['first_touch', 'last_touch', 'linear', 'time_decay']
const MAX_SINCE_DAYS = 365 * 6

/** Attribution is the heaviest of the six readers (it walks every
 *  couple's ribbon), so the fan-out cap is tighter than the overview's. */
const MAX_VENUES = 6

export async function GET(req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  const url = new URL(req.url)
  const modelParam = url.searchParams.get('model')
  const model: AttributionModel = MODELS.includes(modelParam as AttributionModel)
    ? (modelParam as AttributionModel)
    : 'first_touch'

  let since: string | undefined
  const sinceDaysRaw = url.searchParams.get('sinceDays')
  if (sinceDaysRaw) {
    const n = Number(sinceDaysRaw)
    if (Number.isFinite(n) && n > 0) {
      const days = Math.min(Math.floor(n), MAX_SINCE_DAYS)
      since = new Date(Date.now() - days * 86_400_000).toISOString()
    }
  }
  const period = since ? { from: since, to: new Date().toISOString() } : undefined

  const allIds = await resolveScopeVenueIds()
  if (allIds.length === 0) {
    return NextResponse.json({ ok: true, model, parts: [], truncated: false })
  }
  const venueIds = allIds.slice(0, MAX_VENUES)

  try {
    const service = createServiceClient()
    const { data: venueRows } = await service
      .from('venues')
      .select('id, name')
      .in('id', venueIds)
    const nameById = new Map<string, string | null>(
      ((venueRows ?? []) as Array<{ id: string; name: string | null }>).map((v) => [
        v.id,
        v.name,
      ]),
    )

    const parts = await Promise.all(
      venueIds.map(async (venueId) => ({
        venueId,
        venueName: nameById.get(venueId) ?? null,
        attribution: await getSourceAttribution(venueId, { model, period }),
      })),
    )

    return NextResponse.json({
      ok: true,
      model,
      parts,
      truncated: allIds.length > venueIds.length,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[intel/canonical/source-attribution] route error:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
