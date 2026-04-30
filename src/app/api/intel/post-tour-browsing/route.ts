import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { getPostTourBrowsingLeads } from '@/lib/services/post-tour-browsing'

/**
 * GET /api/intel/post-tour-browsing
 *
 * Returns leads who toured the venue and have since been active
 * on a tracked vendor platform (Knot, Instagram, Pinterest, etc.).
 * Strong "still considering" signal — coordinator can send a
 * timely check-in while the venue is still top-of-mind.
 *
 * Auth: caller must be authenticated to a venue.
 */
export async function GET(_req: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const sb = createServiceClient()
  try {
    const leads = await getPostTourBrowsingLeads(sb, auth.venueId)
    return NextResponse.json({ leads })
  } catch (err) {
    console.error('[api/intel/post-tour-browsing]', err)
    return NextResponse.json({ error: 'Failed to load post-tour browsing leads' }, { status: 500 })
  }
}
