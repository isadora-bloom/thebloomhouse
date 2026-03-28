import { createServerSupabaseClient } from '@/lib/supabase/server'
import { NextRequest, NextResponse } from 'next/server'
import {
  detectTrendDeviations,
  fetchTrendsForVenue,
} from '@/lib/services/trends'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — Recent trends + deviations for the authenticated user's venue
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = await createServerSupabaseClient()

    // Last 8 weeks of trend data
    const eightWeeksAgo = new Date(Date.now() - 8 * 7 * 24 * 60 * 60 * 1000)
      .toISOString()
      .split('T')[0]

    const { data: trends, error } = await supabase
      .from('search_trends')
      .select('*')
      .eq('venue_id', auth.venueId)
      .gte('week', eightWeeksAgo)
      .order('week', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    const deviations = await detectTrendDeviations(auth.venueId)

    return NextResponse.json({ trends: trends ?? [], deviations })
  } catch (err) {
    console.error('[api/intel/trends] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Trigger a manual trend refresh for the venue
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const rowsUpserted = await fetchTrendsForVenue(auth.venueId)
    return NextResponse.json({ success: true, rowsUpserted })
  } catch (err) {
    console.error('[api/intel/trends] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
