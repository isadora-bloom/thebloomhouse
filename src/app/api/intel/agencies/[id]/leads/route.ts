import { NextRequest, NextResponse } from 'next/server'
import {
  getPlatformAuth,
  unauthorized,
  badRequest,
  serverError,
} from '@/lib/api/auth-helpers'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'
import { createServiceClient } from '@/lib/supabase/service'
import { listEngagementsForAgency } from '@/lib/services/intel/marketing-agencies'

interface RouteContext {
  params: Promise<{ id: string }>
}

interface AttributionRow {
  wedding_id: string | null
  source_platform: string | null
  decided_at: string
}

interface WeddingRow {
  id: string
  status: string | null
  estimated_value: number | null
  inquiry_date: string | null
  booked_at: string | null
  partner1_name: string | null
  partner2_name: string | null
  wedding_date: string | null
}

/**
 * GET /api/intel/agencies/[id]/leads
 *
 * Wave 6E — drill-down. Returns weddings whose first-touch attribution
 * landed on a channel this agency manages, within the requested window.
 *
 * Query params:
 *   ?venue_id=UUID   — single venue (defaults to auth.venueId)
 *   ?status=booked   — optional wedding status filter
 *   ?window=DAYS     — default 90, clamped 1..3650
 */
export async function GET(request: NextRequest, ctx: RouteContext) {
  const plan = await requirePlan(request, 'pre_opening')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()
  const { id } = await ctx.params
  if (!id) return badRequest('agency id required')

  const sp = request.nextUrl.searchParams
  const venueIdParam = sp.get('venue_id')
  const statusFilter = sp.get('status')
  const windowParam = parseInt(sp.get('window') ?? '', 10)
  const windowDays =
    Number.isFinite(windowParam) && windowParam > 0
      ? Math.min(windowParam, 3650)
      : 90

  const venueIds = venueIdParam ? [venueIdParam] : [auth.venueId]

  const startDate = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  try {
    const engagements = await listEngagementsForAgency(id, { venueIds })
    const managed = new Set<string>()
    for (const e of engagements) for (const c of e.managedChannels) managed.add(c)
    const managedChannels = [...managed]
    if (managedChannels.length === 0) {
      return NextResponse.json({ leads: [], message: 'no managed channels' })
    }

    const service = createServiceClient()
    const { data: attRows } = await service
      .from('attribution_events')
      .select('wedding_id, source_platform, decided_at')
      .in('venue_id', venueIds)
      .in('source_platform', managedChannels)
      .eq('is_first_touch', true)
      .is('reverted_at', null)
      .gte('decided_at', startDate)
      .order('decided_at', { ascending: false })

    const channelByWeddingId = new Map<string, string>()
    const firstTouchByWeddingId = new Map<string, string>()
    const weddingIds = new Set<string>()
    for (const r of (attRows ?? []) as AttributionRow[]) {
      if (r.wedding_id) {
        weddingIds.add(r.wedding_id)
        if (!channelByWeddingId.has(r.wedding_id)) {
          channelByWeddingId.set(
            r.wedding_id,
            r.source_platform ?? 'unknown',
          )
          firstTouchByWeddingId.set(r.wedding_id, r.decided_at)
        }
      }
    }
    if (weddingIds.size === 0) {
      return NextResponse.json({ leads: [] })
    }

    let wq = service
      .from('weddings')
      .select(
        'id, status, estimated_value, inquiry_date, booked_at, partner1_name, partner2_name, wedding_date',
      )
      .in('id', [...weddingIds])
    if (statusFilter) {
      wq = wq.eq('status', statusFilter)
    }
    const { data: wRows } = await wq

    const leads = ((wRows ?? []) as WeddingRow[]).map((w) => ({
      id: w.id,
      status: w.status,
      estimatedValueCents:
        w.estimated_value !== null && Number.isFinite(Number(w.estimated_value))
          ? Math.round(Number(w.estimated_value) * 100)
          : null,
      inquiryDate: w.inquiry_date,
      bookedAt: w.booked_at,
      partner1Name: w.partner1_name,
      partner2Name: w.partner2_name,
      weddingDate: w.wedding_date,
      attributedChannel: channelByWeddingId.get(w.id) ?? null,
      firstTouchAt: firstTouchByWeddingId.get(w.id) ?? null,
    }))

    leads.sort((a, b) => {
      const ax = a.firstTouchAt ?? ''
      const bx = b.firstTouchAt ?? ''
      return bx.localeCompare(ax)
    })

    return NextResponse.json({ leads })
  } catch (err) {
    return serverError(err)
  }
}
