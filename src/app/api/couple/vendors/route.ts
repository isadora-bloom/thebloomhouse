import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/couple/vendors
// Tables: vendor_recommendations (read-only), contracts (read-only here)
// Couples view venue-recommended vendors + their own uploaded contracts.
// Contract creation is handled by /api/portal/contracts.
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(_request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()

    // Venue-level recommended vendors
    const { data: recommended, error: recErr } = await supabase
      .from('vendor_recommendations')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('sort_order', { ascending: true })

    if (recErr) throw recErr

    // Couple's uploaded contracts
    const { data: contracts, error: conErr } = await supabase
      .from('contracts')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('created_at', { ascending: false })

    if (conErr) throw conErr

    return NextResponse.json({
      data: {
        recommended: recommended ?? [],
        contracts: contracts ?? [],
      },
    })
  } catch (error) {
    return serverError(error)
  }
}
