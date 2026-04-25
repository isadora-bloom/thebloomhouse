import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import {
  computeSourceFunnel,
  type AttributionModel,
  type SourceFunnelRow,
} from '@/lib/services/attribution'

/**
 * GET /api/intel/sources/funnel
 *
 * Returns per-source × per-funnel-step counts under a chosen attribution
 * model. Backs /intel/sources's source-comparison table.
 *
 * Query params (all optional):
 *   ?venue_id=UUID    — single venue (defaults to auth.venueId)
 *   ?group_id=UUID    — every venue in this venue_group
 *   ?org_id=UUID      — every venue in this org
 *   ?model=first_touch|last_touch|linear  — attribution model
 *                       (defaults to first_touch)
 *   ?from=ISO         — inclusive lower bound on touchpoint occurred_at
 *   ?to=ISO           — exclusive upper bound on touchpoint occurred_at
 *
 * Response:
 *   {
 *     model,
 *     rows: Array<SourceFunnelRow & { venueId, venueName }>,
 *     totals: { inquiries, tours_booked, tours_conducted, proposals_sent, bookings, revenue }
 *   }
 *
 * Gated behind the `intelligence` plan tier — same as the rest of /intel.
 */
export async function GET(request: NextRequest) {
  const plan = await requirePlan(request, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = request.nextUrl.searchParams
  const venueIdParam = sp.get('venue_id')
  const groupIdParam = sp.get('group_id')
  const orgIdParam = sp.get('org_id')
  const modelParam = sp.get('model') as AttributionModel | null
  const fromParam = sp.get('from') ?? undefined
  const toParam = sp.get('to') ?? undefined

  const allowedModels: AttributionModel[] = ['first_touch', 'last_touch', 'linear']
  const model: AttributionModel =
    modelParam && allowedModels.includes(modelParam) ? modelParam : 'first_touch'

  const sb = createServiceClient()

  try {
    // ---- Resolve target venue IDs based on scope ----
    let venueIds: string[] = []
    if (groupIdParam) {
      const { data: members } = await sb
        .from('venue_group_members')
        .select('venue_id')
        .eq('group_id', groupIdParam)
      venueIds = (members ?? []).map((m) => m.venue_id as string)
    } else if (orgIdParam) {
      const { data: orgVenues } = await sb
        .from('venues')
        .select('id')
        .eq('org_id', orgIdParam)
      venueIds = (orgVenues ?? []).map((v) => v.id as string)
    } else if (venueIdParam) {
      venueIds = [venueIdParam]
    } else {
      venueIds = [auth.venueId]
    }
    if (venueIds.length === 0) {
      return NextResponse.json({ model, rows: [], totals: emptyTotals() })
    }

    // ---- Venue name lookup for labelling rows ----
    const { data: venueRows } = await sb
      .from('venues')
      .select('id, name')
      .in('id', venueIds)
    const venueNameById = new Map<string, string>()
    for (const v of venueRows ?? []) {
      venueNameById.set(v.id as string, (v.name as string) ?? '')
    }

    // ---- Compute attribution per venue (parallel) ----
    type Row = SourceFunnelRow & { venueId: string; venueName: string }
    const perVenue = await Promise.all(
      venueIds.map(async (vid) => {
        const rows = await computeSourceFunnel(vid, { model, from: fromParam, to: toParam })
        return rows.map<Row>((r) => ({ ...r, venueId: vid, venueName: venueNameById.get(vid) ?? '' }))
      })
    )
    const flat = perVenue.flat()

    // ---- Cross-venue totals ----
    const totals = emptyTotals()
    for (const r of flat) {
      totals.inquiries += r.inquiries
      totals.tours_booked += r.tours_booked
      totals.tours_conducted += r.tours_conducted
      totals.proposals_sent += r.proposals_sent
      totals.bookings += r.bookings
      totals.revenue += r.revenue
    }

    return NextResponse.json({ model, rows: flat, totals })
  } catch (err) {
    console.error('[api/intel/sources/funnel]', err)
    return NextResponse.json({ error: 'Failed to compute source funnel' }, { status: 500 })
  }
}

function emptyTotals() {
  return {
    inquiries: 0,
    tours_booked: 0,
    tours_conducted: 0,
    proposals_sent: 0,
    bookings: 0,
    revenue: 0,
  }
}
