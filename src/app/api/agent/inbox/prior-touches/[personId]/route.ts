import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getPriorTouches } from '@/lib/services/prior-touches'

/**
 * GET /api/agent/inbox/prior-touches/:personId
 *
 * Returns the PriorTouchSummary for a given person, so the inbox inquiry
 * card can surface "liked you on Instagram March 14, visited your website
 * 3 times in April, and inquired through The Knot today."
 *
 * Authenticated + venue-scoped. Person must belong to a venue the caller
 * has access to (same venue or same org for admins). 404 on mismatch.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ personId: string }> }
) {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { personId } = await params
  if (!personId) {
    return NextResponse.json({ error: 'Missing personId' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Pull the person's venue_id and verify it's in scope.
  const { data: person, error: personErr } = await supabase
    .from('people')
    .select('id, venue_id')
    .eq('id', personId)
    .maybeSingle()

  if (personErr || !person) {
    return NextResponse.json({ error: 'Person not found' }, { status: 404 })
  }

  const personVenueId = person.venue_id as string | null
  if (!personVenueId) {
    return NextResponse.json({ error: 'Person has no venue' }, { status: 404 })
  }

  // Scope check: allow if the venue matches the caller's venue, or (for
  // org-level roles) the venue belongs to the same org.
  let allowed = personVenueId === auth.venueId
  if (!allowed && auth.orgId) {
    const { data: venueRow } = await supabase
      .from('venues')
      .select('org_id')
      .eq('id', personVenueId)
      .maybeSingle()
    if (venueRow?.org_id && venueRow.org_id === auth.orgId) {
      allowed = true
    }
  }

  if (!allowed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  try {
    const summary = await getPriorTouches({
      supabase,
      venueId: personVenueId,
      personId,
    })
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[prior-touches] lookup failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
