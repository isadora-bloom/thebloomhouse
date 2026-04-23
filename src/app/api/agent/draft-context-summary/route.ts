import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'
import { summarizeDraftContext } from '@/lib/services/draft-context-summary'

// ---------------------------------------------------------------------------
// GET: Draft context summary for a venue
//   ?venueId=<uuid>  (optional; falls back to auth.venueId from scope)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const requestedVenueId = searchParams.get('venueId')
    const venueId = requestedVenueId ?? auth.venueId

    if (!venueId) {
      return NextResponse.json(
        { error: 'venueId is required' },
        { status: 400 }
      )
    }

    // If a specific venue was requested, verify the caller can see it.
    // Coordinators/managers: only their own venue_id. Org admins/super admins:
    // any venue in their org.
    if (requestedVenueId && requestedVenueId !== auth.venueId) {
      const isAdmin = auth.role === 'org_admin' || auth.role === 'super_admin'
      if (!isAdmin) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      const service = createServiceClient()
      const { data: v } = await service
        .from('venues')
        .select('org_id')
        .eq('id', requestedVenueId)
        .maybeSingle()
      if (!v || (auth.orgId && v.org_id !== auth.orgId)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
    }

    const summary = await summarizeDraftContext(venueId)

    return NextResponse.json({ summary })
  } catch (err) {
    console.error('[api/agent/draft-context-summary] GET error:', err)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
