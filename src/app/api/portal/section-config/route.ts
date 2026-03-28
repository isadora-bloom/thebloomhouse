import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// Portal Section Config API
//
// GET  ?venue_id=xxx              → all sections for venue (platform auth)
// GET  ?venue_id=xxx&active=true  → non-off sections (platform auth)
// GET  ?slug=xxx&couple=true      → couple-visible sections (no auth)
// PATCH                           → update single section
// PATCH ?bulk=true                → bulk update sections
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const slug = searchParams.get('slug')
  const coupleMode = searchParams.get('couple') === 'true'

  // Public couple endpoint: no auth required
  if (slug && coupleMode) {
    return handleCoupleGet(slug)
  }

  // Platform endpoints require auth
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const venueId = searchParams.get('venue_id') || auth.venueId
    const activeOnly = searchParams.get('active') === 'true'

    const supabase = createServiceClient()
    let query = supabase
      .from('portal_section_config')
      .select('*')
      .eq('venue_id', venueId)
      .order('sort_order', { ascending: true })

    if (activeOnly) {
      query = query.neq('visibility', 'off')
    }

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json({ data: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// Public: couple portal fetches visible sections by venue slug
async function handleCoupleGet(slug: string) {
  try {
    const supabase = createServiceClient()

    // Resolve slug to venue id
    const { data: venue, error: venueErr } = await supabase
      .from('venues')
      .select('id')
      .eq('slug', slug)
      .single()

    if (venueErr || !venue) {
      return NextResponse.json({ data: [] })
    }

    const { data, error } = await supabase
      .from('portal_section_config')
      .select('section_key, label, sort_order, icon')
      .eq('venue_id', venue.id)
      .eq('visibility', 'both')
      .order('sort_order', { ascending: true })

    if (error) throw error

    return NextResponse.json({ data: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await getPlatformAuth()
    if (!auth) return unauthorized()

    const { searchParams } = new URL(request.url)
    const bulk = searchParams.get('bulk') === 'true'
    const body = await request.json()

    const supabase = createServiceClient()

    if (bulk) {
      // Bulk update: { sections: [{ section_key, visibility, sort_order? }] }
      const { sections } = body as {
        sections: { section_key: string; visibility: string; sort_order?: number }[]
      }
      if (!Array.isArray(sections) || sections.length === 0) {
        return badRequest('sections array is required')
      }

      const validVisibility = ['admin_only', 'both', 'off']
      const results = []

      for (const section of sections) {
        if (!section.section_key) continue
        if (section.visibility && !validVisibility.includes(section.visibility)) continue

        const updates: Record<string, unknown> = {
          updated_at: new Date().toISOString(),
        }
        if (section.visibility) updates.visibility = section.visibility
        if (section.sort_order !== undefined) updates.sort_order = section.sort_order

        const { data, error } = await supabase
          .from('portal_section_config')
          .update(updates)
          .eq('venue_id', auth.venueId)
          .eq('section_key', section.section_key)
          .select()
          .single()

        if (!error && data) results.push(data)
      }

      return NextResponse.json({ data: results })
    }

    // Single update: { section_key, visibility, sort_order? }
    const { section_key, visibility, sort_order } = body
    if (!section_key) return badRequest('section_key is required')

    const validVisibility = ['admin_only', 'both', 'off']
    if (visibility && !validVisibility.includes(visibility)) {
      return badRequest('visibility must be admin_only, both, or off')
    }

    const updates: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    }
    if (visibility) updates.visibility = visibility
    if (sort_order !== undefined) updates.sort_order = sort_order

    const { data, error } = await supabase
      .from('portal_section_config')
      .update(updates)
      .eq('venue_id', auth.venueId)
      .eq('section_key', section_key)
      .select()
      .single()

    if (error) throw error

    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}
