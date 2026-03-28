import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// GET /api/couple/website — get website settings (or check slug availability)
export async function GET(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const checkSlug = req.nextUrl.searchParams.get('check_slug')
    const supabase = createServiceClient()

    // Slug availability check
    if (checkSlug) {
      const { data: existing, error } = await supabase
        .from('wedding_website_settings')
        .select('id, wedding_id')
        .eq('slug', checkSlug)
        .maybeSingle()

      if (error) return serverError(error)

      // Available if no record exists, or it belongs to this couple's own wedding
      const available = !existing || existing.wedding_id === auth.weddingId

      return NextResponse.json({ available })
    }

    // Return website settings for this wedding
    const { data, error } = await supabase
      .from('wedding_website_settings')
      .select('*')
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    if (error) return serverError(error)

    return NextResponse.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// POST /api/couple/website — create website settings
export async function POST(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await req.json()
    const {
      slug,
      is_published,
      theme,
      accent_color,
      couple_names,
      sections_order,
      sections_enabled,
      our_story,
      dress_code,
      registry_links,
      faq,
      things_to_do,
    } = body

    if (!slug) return badRequest('slug is required')

    const supabase = createServiceClient()

    // Check slug uniqueness
    const { data: existing, error: slugError } = await supabase
      .from('wedding_website_settings')
      .select('id')
      .eq('slug', slug)
      .maybeSingle()

    if (slugError) return serverError(slugError)
    if (existing) {
      return NextResponse.json(
        { error: 'Slug is already taken' },
        { status: 409 }
      )
    }

    const { data, error } = await supabase
      .from('wedding_website_settings')
      .insert({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        slug,
        is_published: is_published ?? false,
        theme: theme ?? 'classic',
        accent_color: accent_color ?? null,
        couple_names: couple_names ?? null,
        sections_order: sections_order ?? [],
        sections_enabled: sections_enabled ?? {},
        our_story: our_story ?? null,
        dress_code: dress_code ?? null,
        registry_links: registry_links ?? [],
        faq: faq ?? [],
        things_to_do: things_to_do ?? [],
      })
      .select()
      .single()

    if (error) return serverError(error)

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// PATCH /api/couple/website — update website settings
export async function PATCH(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await req.json()
    const { id, ...fields } = body

    if (!id) return badRequest('id is required')

    // If slug is being changed, check uniqueness
    if (fields.slug) {
      const supabase = createServiceClient()
      const { data: existing, error: slugError } = await supabase
        .from('wedding_website_settings')
        .select('id')
        .eq('slug', fields.slug)
        .neq('id', id)
        .maybeSingle()

      if (slugError) return serverError(slugError)
      if (existing) {
        return NextResponse.json(
          { error: 'Slug is already taken' },
          { status: 409 }
        )
      }
    }

    // Strip fields that shouldn't be updated
    delete fields.venue_id
    delete fields.wedding_id

    if (Object.keys(fields).length === 0) {
      return badRequest('No fields to update')
    }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('wedding_website_settings')
      .update(fields)
      .eq('id', id)
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) return serverError(error)

    return NextResponse.json(data)
  } catch (err) {
    return serverError(err)
  }
}
