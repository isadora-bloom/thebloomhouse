import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { apiError } from '@/lib/api/api-error'

/**
 * GET /api/couple/branding?slug=<venue slug>
 *
 * Public, by design. The couple portal's signed-out pages (login,
 * register, forgot-password, reset-password) show the venue's name, logo
 * and tagline before there is any session. They used to read `venues`
 * and `venue_config` straight from the browser with the anon key, which
 * only the demo venues allow (migration 392's demo-anon policies), so
 * every real venue's sign-in page answered 406 from PostgREST and fell
 * back to "Wedding Portal". Found by the §27 journey on 2026-09-15.
 *
 * The slug is already in the URL the couple was sent, and the three
 * fields are what the page shows to anyone who opens it. Nothing else
 * from either table leaves here.
 */

const SLUG = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/

export async function GET(req: NextRequest) {
  try {
    const slug = (req.nextUrl.searchParams.get('slug') ?? '').trim().toLowerCase()
    if (!SLUG.test(slug)) {
      return NextResponse.json({ error: 'slug required' }, { status: 400 })
    }

    const supabase = createServiceClient()
    const { data: venue, error } = await supabase
      .from('venues')
      .select('id, name')
      .eq('slug', slug)
      .maybeSingle()
    if (error) throw error
    if (!venue) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const { data: config } = await supabase
      .from('venue_config')
      .select('business_name, logo_url, portal_tagline')
      .eq('venue_id', venue.id)
      .maybeSingle()

    return NextResponse.json(
      {
        venueName: (config?.business_name as string | null) || venue.name,
        logoUrl: (config?.logo_url as string | null) || null,
        portalTagline: (config?.portal_tagline as string | null) || null,
      },
      { headers: { 'Cache-Control': 'public, max-age=60' } }
    )
  } catch (err) {
    return apiError(err)
  }
}
