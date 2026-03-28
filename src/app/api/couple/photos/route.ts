import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// GET /api/couple/photos — list all photos for wedding
export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('photo_library')
      .select('*')
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })

    if (error) return serverError(error)

    return NextResponse.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// POST /api/couple/photos — create a photo record
export async function POST(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await req.json()
    const { image_url, caption, tags, is_website } = body

    if (!image_url) return badRequest('image_url is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('photo_library')
      .insert({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        image_url,
        caption: caption ?? null,
        tags: tags ?? [],
        is_website: is_website ?? false,
        uploaded_by: auth.userId,
      })
      .select()
      .single()

    if (error) return serverError(error)

    return NextResponse.json(data, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// PATCH /api/couple/photos — update a photo record
export async function PATCH(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await req.json()
    const { id, caption, tags, is_website } = body

    if (!id) return badRequest('id is required')

    const updates: Record<string, unknown> = {}
    if (caption !== undefined) updates.caption = caption
    if (tags !== undefined) updates.tags = tags
    if (is_website !== undefined) updates.is_website = is_website

    if (Object.keys(updates).length === 0) {
      return badRequest('No fields to update')
    }

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('photo_library')
      .update(updates)
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

// DELETE /api/couple/photos?id=xxx — delete a photo
export async function DELETE(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const id = req.nextUrl.searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('photo_library')
      .delete()
      .eq('id', id)
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)

    if (error) return serverError(error)

    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
