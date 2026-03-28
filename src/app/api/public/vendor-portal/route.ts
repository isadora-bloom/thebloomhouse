import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// /api/public/vendor-portal — Token-based vendor self-service (no auth)
// ---------------------------------------------------------------------------

// ---- GET ?token=xxx ----
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const token = searchParams.get('token')

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'token is required' }, { status: 400 })
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('vendor_recommendations')
      .select(
        'id, vendor_name, vendor_type, contact_email, contact_phone, website_url, description, logo_url, bio, instagram_url, facebook_url, pricing_info, special_offer, offer_expires_at, portfolio_photos, last_updated_by_vendor'
      )
      .eq('portal_token', token)
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 })
    }

    // Also fetch the venue name for display
    const { data: vendorFull } = await supabase
      .from('vendor_recommendations')
      .select('venue_id')
      .eq('portal_token', token)
      .single()

    let venueName: string | null = null
    if (vendorFull?.venue_id) {
      const { data: venue } = await supabase
        .from('venues')
        .select('name')
        .eq('id', vendorFull.venue_id)
        .single()
      venueName = venue?.name ?? null
    }

    return NextResponse.json({ data: { ...data, venue_name: venueName } })
  } catch (error) {
    console.error('[api/public/vendor-portal] GET error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---- PATCH ----
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json()
    const { token, ...fields } = body

    if (!token || typeof token !== 'string') {
      return NextResponse.json({ error: 'token is required' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Verify token exists
    const { data: existing, error: lookupError } = await supabase
      .from('vendor_recommendations')
      .select('id')
      .eq('portal_token', token)
      .single()

    if (lookupError || !existing) {
      return NextResponse.json({ error: 'Invalid or expired token' }, { status: 404 })
    }

    // Only allow vendor-editable fields
    const allowed = [
      'bio',
      'contact_email',
      'contact_phone',
      'website_url',
      'instagram_url',
      'facebook_url',
      'pricing_info',
      'special_offer',
      'offer_expires_at',
      'portfolio_photos',
    ] as const

    const updates: Record<string, unknown> = {}
    for (const key of allowed) {
      if (key in fields) {
        updates[key] = fields[key]
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
    }

    // Validate portfolio_photos array limit
    if (updates.portfolio_photos) {
      if (!Array.isArray(updates.portfolio_photos)) {
        return NextResponse.json({ error: 'portfolio_photos must be an array' }, { status: 400 })
      }
      if ((updates.portfolio_photos as string[]).length > 8) {
        return NextResponse.json({ error: 'Maximum 8 portfolio photos allowed' }, { status: 400 })
      }
    }

    // Set last_updated_by_vendor timestamp
    updates.last_updated_by_vendor = new Date().toISOString()

    const { data, error } = await supabase
      .from('vendor_recommendations')
      .update(updates)
      .eq('portal_token', token)
      .select(
        'id, vendor_name, vendor_type, contact_email, contact_phone, website_url, description, logo_url, bio, instagram_url, facebook_url, pricing_info, special_offer, offer_expires_at, portfolio_photos, last_updated_by_vendor'
      )
      .single()

    if (error) throw error

    return NextResponse.json({ data })
  } catch (error) {
    console.error('[api/public/vendor-portal] PATCH error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
