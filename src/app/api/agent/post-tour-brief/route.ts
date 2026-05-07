import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { fetchCachedTourBrief, generatePostTourBrief } from '@/lib/services/brain/post-tour-brief'

// ---------------------------------------------------------------------------
// POST { tourId }
//
// Generates the post-tour Sage brief + a personalised follow-up draft.
// Authenticated coordinator only. Verifies the tour belongs to the
// caller's venue (or org for admins) before invoking the service.
//
// Mirrors the access-control pattern used by /api/agent/tour-transcript-
// extract so coordinators can't read briefs for tours they don't own.
// ---------------------------------------------------------------------------

// Connective tissue II / fix #1 (2026-04-30): GET returns the cached
// brief from migration 108's persisted columns. Without this, every
// surface that wants to display a brief had to re-invoke Claude. POST
// remains the regenerate path.
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const tourId = request.nextUrl.searchParams.get('tourId') ?? request.nextUrl.searchParams.get('tour_id')
  if (!tourId) return NextResponse.json({ error: 'tourId required' }, { status: 400 })

  const service = createServiceClient()
  const { data: tour } = await service
    .from('tours')
    .select('id, venue_id')
    .eq('id', tourId)
    .maybeSingle()
  if (!tour) return NextResponse.json({ error: 'Tour not found' }, { status: 404 })
  const isAdmin = auth.role === 'org_admin' || auth.role === 'super_admin'
  if (!isAdmin && (tour as { venue_id: string }).venue_id !== auth.venueId) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  try {
    const brief = await fetchCachedTourBrief(tourId)
    return NextResponse.json({ brief })
  } catch (err) {
    console.error('[api/agent/post-tour-brief] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: { tourId?: string }
  try {
    body = (await request.json()) as { tourId?: string }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const tourId = body?.tourId
  if (!tourId || typeof tourId !== 'string') {
    return NextResponse.json({ error: 'tourId is required' }, { status: 400 })
  }

  try {
    const service = createServiceClient()
    const { data: tour } = await service
      .from('tours')
      .select('id, venue_id, venues:venues!inner(org_id)')
      .eq('id', tourId)
      .maybeSingle()

    if (!tour) {
      return NextResponse.json({ error: 'Tour not found' }, { status: 404 })
    }

    const tourVenueId = tour.venue_id as string
    const tourOrgId = (
      tour.venues as unknown as { org_id: string | null } | null
    )?.org_id

    const isAdmin = auth.role === 'org_admin' || auth.role === 'super_admin'
    if (!isAdmin && tourVenueId !== auth.venueId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
    if (isAdmin && auth.orgId && tourOrgId && tourOrgId !== auth.orgId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    const brief = await generatePostTourBrief(tourId)
    return NextResponse.json({ brief })
  } catch (err) {
    console.error('[api/agent/post-tour-brief] POST error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
