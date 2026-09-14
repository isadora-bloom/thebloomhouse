import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { requireAgencyScope } from '@/lib/services/intel/agency-access'
import { createServiceClient } from '@/lib/supabase/service'
import { listEngagementsForAgency } from '@/lib/services/intel/marketing-agencies'
import { loadChannelLeads } from '@/lib/intel/readers/channel-leads'

export const maxDuration = 120

interface RouteContext {
  params: Promise<{ id: string }>
}

/**
 * GET /api/intel/agencies/[id]/leads
 *
 * Wave 6E — drill-down. The couples whose first touch landed on a
 * channel this agency manages, inside the requested window.
 *
 * W64: this used to read `attribution_events` for the first touch,
 * `weddings` for the row and `people` for the partner names — a third
 * derivation of "which channel found this couple", sitting next to the
 * agency ROI card's and the channel table's. All three now come out of
 * `buildCoupleAttribution`, the builder the canonical
 * `getSourceAttribution` wraps, through `loadChannelLeads`. The count on
 * the agency card and the length of this list cannot drift apart,
 * because they are the same computation with a filter on it.
 *
 * Two deliberate changes an operator will see:
 *   - `status` is the spine lifecycle, not `weddings.status`. One
 *     vocabulary, the one the pills speak.
 *   - `valueCents` is always null. The old figure was
 *     `weddings.quoted_value`, and a quote is not revenue; `couples`
 *     carries no revenue column, so the honest answer is a dash.
 *
 * Query params:
 *   ?venue_id=UUID   — single venue (defaults to auth.venueId)
 *   ?status=booked   — optional lifecycle filter (spine vocabulary)
 *   ?window=DAYS     — default 90, clamped 1..3650
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')
  // S5 (2026-09-14 audit item 5): the [id] segment is caller supplied and
  // every read below uses the service-role client, so scope it here.
  const denied = await requireAgencyScope(id, auth)
  if (denied) return denied

  const sp = request.nextUrl.searchParams
  const venueIdParam = sp.get('venue_id')
  const statusFilter = sp.get('status')
  const windowParam = parseInt(sp.get('window') ?? '', 10)
  const windowDays =
    Number.isFinite(windowParam) && windowParam > 0
      ? Math.min(windowParam, 3650)
      : 90

  const venueIds = (venueIdParam ? [venueIdParam] : [auth.venueId]).filter(
    (v): v is string => Boolean(v),
  )
  if (venueIds.length === 0) return badRequest('no venue in scope')

  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  try {
    const engagements = await listEngagementsForAgency(id, { venueIds })
    const managed = new Set<string>()
    for (const e of engagements) for (const c of e.managedChannels) managed.add(c)
    const managedChannels = [...managed]
    if (managedChannels.length === 0) {
      return NextResponse.json({ leads: [], message: 'no managed channels' })
    }

    const service = createServiceClient()

    // Attribution is read one venue at a time: credit is a per-venue
    // computation and merging two venues' ribbons would credit a channel
    // for couples it never touched.
    const perVenue = await Promise.all(
      venueIds.map((venueId) =>
        loadChannelLeads(service, venueId, { channels: managedChannels, since }),
      ),
    )
    let leads = perVenue.flat()

    if (statusFilter) {
      leads = leads.filter((l) => l.lifecycleState === statusFilter)
    }

    leads.sort((a, b) => (b.firstTouchAt ?? '').localeCompare(a.firstTouchAt ?? ''))

    return NextResponse.json({
      leads: leads.map((l) => ({
        // The drill-down still links into the wedding-keyed operator
        // pages, so both ids travel. `coupleId` is the one to key on.
        coupleId: l.coupleId,
        id: l.sourceWeddingId ?? l.coupleId,
        status: l.lifecycleState,
        estimatedValueCents: l.valueCents,
        inquiryDate: l.firstTouchAt,
        bookedAt: l.bookedAt,
        partner1Name: l.primaryContactName,
        partner2Name: l.partnerContactName,
        weddingDate: l.weddingDate,
        attributedChannel: l.attributedChannel,
        firstTouchAt: l.firstTouchAt,
        creditWeight: l.creditWeight,
      })),
      valueNote:
        'Lead value is not shown: the identity spine carries no revenue column, and the quoted value this list used to print was a quote, not a booking.',
    })
  } catch (err) {
    return serverError(err)
  }
}
