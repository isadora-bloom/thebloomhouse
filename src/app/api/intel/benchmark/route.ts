import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { requirePlan, planErrorBody } from '@/lib/auth/require-plan'

// ---------------------------------------------------------------------------
// GET /api/intel/benchmark
//
// Phase 4 Task 45. Cross-venue benchmark. Only meaningful at group or
// company scope. Returns one row per venue with the key KPIs plus a
// rollup summary.
//
// Query params:
//   scope    'company' | 'group'   default 'company'
//   groupId  uuid                  required when scope='group'
//
// Response:
//   {
//     venues: Array<{
//       venueId, venueName,
//       overallScore,             // null if no venue_health row yet
//       bookingRate,              // 0..1 over last 90d inquiries
//       avgRevenue,               // mean booking_value over booked+completed last 90d
//       responseTimeMinutes,      // mean lag from inquiry_date → first_response_at
//       availabilityFillRate,     // 0..1 from latest venue_health
//       tourConversionRate,       // 0..1 from latest venue_health (stored 0..100 score)
//     }>,
//     rollup: {
//       avgHealth,                // mean overall_score across venues with data
//       bestVenueId, weakestVenueId,
//       totalBookings,
//     }
//   }
//
// Gating: intelligence plan tier (mirrors every other /api/intel/* route).
// Data access: service client — we've already authed the user and resolved
// their org, so cross-venue reads inside the org are safe.
// ---------------------------------------------------------------------------

interface BenchmarkVenue {
  venueId: string
  venueName: string
  overallScore: number | null
  bookingRate: number | null
  avgRevenue: number | null
  responseTimeMinutes: number | null
  availabilityFillRate: number | null
  tourConversionRate: number | null
}

interface BenchmarkResponse {
  venues: BenchmarkVenue[]
  rollup: {
    avgHealth: number | null
    bestVenueId: string | null
    weakestVenueId: string | null
    totalBookings: number
  }
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  const plan = await requirePlan(req, 'intelligence')
  if (!plan.ok) return NextResponse.json(planErrorBody(plan), { status: plan.status })

  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sp = req.nextUrl.searchParams
  const scope = (sp.get('scope') || 'company') as 'company' | 'group'
  const groupId = sp.get('groupId')

  if (scope !== 'company' && scope !== 'group') {
    return NextResponse.json(
      { error: 'scope must be "company" or "group"' },
      { status: 400 }
    )
  }
  if (scope === 'group' && !groupId) {
    return NextResponse.json(
      { error: 'groupId is required when scope=group' },
      { status: 400 }
    )
  }

  const service = createServiceClient()

  // ----- Resolve the venue list in scope ----------------------------------
  let venueIds: string[] = []
  let venueNameById = new Map<string, string>()

  if (scope === 'group') {
    // Group scope: members only, but verify the group belongs to the
    // caller's org so a crafted groupId can't reach across tenants.
    const { data: group } = await service
      .from('venue_groups')
      .select('id, org_id')
      .eq('id', groupId as string)
      .maybeSingle()

    if (!group) {
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    }
    if (auth.orgId && group.org_id && group.org_id !== auth.orgId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const { data: members } = await service
      .from('venue_group_members')
      .select('venue_id')
      .eq('group_id', groupId as string)

    venueIds = (members ?? []).map((m) => m.venue_id as string)

    if (venueIds.length > 0) {
      const { data: venueRows } = await service
        .from('venues')
        .select('id, name')
        .in('id', venueIds)
      for (const v of venueRows ?? []) {
        venueNameById.set(v.id as string, (v.name as string) ?? '')
      }
    }
  } else {
    // Company scope: every venue in the caller's org.
    if (!auth.orgId) {
      return NextResponse.json(
        { error: 'No org associated with this account' },
        { status: 400 }
      )
    }
    const { data: venueRows } = await service
      .from('venues')
      .select('id, name')
      .eq('org_id', auth.orgId)
    for (const v of venueRows ?? []) {
      venueIds.push(v.id as string)
      venueNameById.set(v.id as string, (v.name as string) ?? '')
    }
  }

  if (venueIds.length === 0) {
    return NextResponse.json<BenchmarkResponse>({
      venues: [],
      rollup: {
        avgHealth: null,
        bestVenueId: null,
        weakestVenueId: null,
        totalBookings: 0,
      },
    })
  }

  // ----- Pull the data we'll aggregate per venue --------------------------
  const ninetyDaysAgoIso = new Date(Date.now() - NINETY_DAYS_MS).toISOString()

  const [healthRes, weddingsRes] = await Promise.all([
    // Every venue_health row in scope. We'll pick the latest per venue
    // client-side — Supabase has no portable DISTINCT ON.
    service
      .from('venue_health')
      .select(
        'venue_id, overall_score, tour_conversion_rate, availability_fill_rate, calculated_at'
      )
      .in('venue_id', venueIds)
      .order('calculated_at', { ascending: false }),
    // Weddings in the last 90 days — used for booking rate, avg revenue,
    // response time mean. Matches the window used by venue-health-compute
    // so numbers line up between this page and /intel/health.
    service
      .from('weddings')
      .select(
        'id, venue_id, status, booking_value, inquiry_date, first_response_at'
      )
      .in('venue_id', venueIds)
      .gte('inquiry_date', ninetyDaysAgoIso),
  ])

  const healthRows = healthRes.data ?? []
  const weddings = weddingsRes.data ?? []

  // Latest health per venue.
  const latestHealthByVenue = new Map<string, (typeof healthRows)[number]>()
  for (const row of healthRows) {
    const vid = row.venue_id as string
    if (!latestHealthByVenue.has(vid)) latestHealthByVenue.set(vid, row)
  }

  // ----- Per-venue aggregation -------------------------------------------
  const bookedStatuses = new Set(['booked', 'completed'])

  const venueCards: BenchmarkVenue[] = venueIds.map((venueId) => {
    const name = venueNameById.get(venueId) ?? ''
    const health = latestHealthByVenue.get(venueId) ?? null

    const vw = weddings.filter((w) => w.venue_id === venueId)
    const totalInquiries = vw.length
    const bookedList = vw.filter((w) => bookedStatuses.has(w.status as string))
    const bookings = bookedList.length

    const bookingRate = totalInquiries > 0 ? bookings / totalInquiries : null

    const revenueValues = bookedList
      .map((w) => Number(w.booking_value) || 0)
      .filter((n) => n > 0)
    const avgRevenue = revenueValues.length > 0
      ? revenueValues.reduce((a, b) => a + b, 0) / revenueValues.length
      : null

    // Response time mean (minutes). Matches venue-health-compute: clamp out
    // > 48h outliers so a single stale inquiry doesn't dominate the mean.
    const responseMinutes: number[] = []
    for (const w of vw) {
      if (!w.inquiry_date || !w.first_response_at) continue
      const lag =
        (new Date(w.first_response_at as string).getTime() -
          new Date(w.inquiry_date as string).getTime()) /
        60000
      if (lag >= 0 && lag < 48 * 60) responseMinutes.push(lag)
    }
    const responseTimeMinutes = responseMinutes.length > 0
      ? responseMinutes.reduce((a, b) => a + b, 0) / responseMinutes.length
      : null

    // venue_health stores subscores as 0-100. Surface them as 0..1 ratios
    // for UI consistency with bookingRate.
    const tourConvScore = health?.tour_conversion_rate
    const fillScore = health?.availability_fill_rate

    return {
      venueId,
      venueName: name,
      overallScore: health?.overall_score != null
        ? Number(health.overall_score)
        : null,
      bookingRate,
      avgRevenue,
      responseTimeMinutes,
      availabilityFillRate: fillScore != null ? Number(fillScore) / 100 : null,
      tourConversionRate: tourConvScore != null ? Number(tourConvScore) / 100 : null,
    }
  })

  // ----- Rollup -----------------------------------------------------------
  const healthScores = venueCards
    .map((v) => v.overallScore)
    .filter((n): n is number => n != null)
  const avgHealth = healthScores.length > 0
    ? Math.round(
        healthScores.reduce((a, b) => a + b, 0) / healthScores.length
      )
    : null

  let bestVenueId: string | null = null
  let weakestVenueId: string | null = null
  let bestScore = -Infinity
  let weakestScore = Infinity
  for (const v of venueCards) {
    if (v.overallScore == null) continue
    if (v.overallScore > bestScore) {
      bestScore = v.overallScore
      bestVenueId = v.venueId
    }
    if (v.overallScore < weakestScore) {
      weakestScore = v.overallScore
      weakestVenueId = v.venueId
    }
  }

  const totalBookings = weddings.filter((w) =>
    bookedStatuses.has(w.status as string)
  ).length

  const body: BenchmarkResponse = {
    venues: venueCards,
    rollup: {
      avgHealth,
      bestVenueId,
      weakestVenueId,
      totalBookings,
    },
  }

  return NextResponse.json(body)
}
