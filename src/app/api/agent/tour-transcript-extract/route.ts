import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { extractTourTranscript } from '@/lib/services/tour-transcript-extract'

// ---------------------------------------------------------------------------
// POST { tourId }
//
// Manual trigger for the Omi tour transcript extraction pipeline. Runs the
// AI extraction, writes the result to tours.transcript_extracted, and
// upserts key_questions into knowledge_gaps (venue-scoped).
//
// Auth: platform coordinator/manager/org_admin/super_admin. The caller
// must have access to the venue the tour belongs to; we verify by loading
// the tour and checking venue ownership before invoking the extractor.
// ---------------------------------------------------------------------------

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

  // Venue access check. Coordinator/manager roles are scoped to their
  // venue_id; org admins and super admins can touch any venue in their
  // org. This mirrors the pattern in draft-context-summary.
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

    const extraction = await extractTourTranscript(tourId)
    return NextResponse.json({ extraction })
  } catch (err) {
    console.error('[api/agent/tour-transcript-extract] POST error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
