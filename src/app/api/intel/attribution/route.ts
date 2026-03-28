import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — Source attribution data + marketing spend
//   ?period_start=YYYY-MM-DD
//   ?period_end=YYYY-MM-DD
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const periodStart = searchParams.get('period_start')
    const periodEnd = searchParams.get('period_end')

    const supabase = createServiceClient()

    // Build source_attribution query
    let attributionQuery = supabase
      .from('source_attribution')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })

    if (periodStart) {
      attributionQuery = attributionQuery.gte('created_at', periodStart)
    }
    if (periodEnd) {
      attributionQuery = attributionQuery.lte('created_at', periodEnd)
    }

    // Build marketing_spend query
    let spendQuery = supabase
      .from('marketing_spend')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('period_start', { ascending: false })

    if (periodStart) {
      spendQuery = spendQuery.gte('period_start', periodStart)
    }
    if (periodEnd) {
      spendQuery = spendQuery.lte('period_end', periodEnd)
    }

    // Execute both queries in parallel
    const [attributionResult, spendResult] = await Promise.all([
      attributionQuery,
      spendQuery,
    ])

    if (attributionResult.error) {
      console.error('[api/intel/attribution] Attribution query error:', attributionResult.error.message)
    }

    if (spendResult.error) {
      console.error('[api/intel/attribution] Spend query error:', spendResult.error.message)
    }

    return NextResponse.json({
      attribution: attributionResult.data ?? [],
      spend: spendResult.data ?? [],
    })
  } catch (err) {
    console.error('[api/intel/attribution] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
