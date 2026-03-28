import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

const INSPO_LIMIT = 20

// GET /api/couple/inspo — list inspo images, optional ?tag= filter
export async function GET(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const tag = req.nextUrl.searchParams.get('tag')

    const supabase = createServiceClient()
    let query = supabase
      .from('inspo_gallery')
      .select('*')
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })

    if (tag) {
      query = query.contains('tags', [tag])
    }

    const { data, error } = await query

    if (error) return serverError(error)

    return NextResponse.json(data)
  } catch (err) {
    return serverError(err)
  }
}

// POST /api/couple/inspo — create inspo image (limit 20 per wedding)
export async function POST(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await req.json()
    const { image_url, caption, tags } = body

    if (!image_url) return badRequest('image_url is required')

    const supabase = createServiceClient()

    // Check count limit
    const { count, error: countError } = await supabase
      .from('inspo_gallery')
      .select('id', { count: 'exact', head: true })
      .eq('wedding_id', auth.weddingId)
      .eq('venue_id', auth.venueId)

    if (countError) return serverError(countError)

    if ((count ?? 0) >= INSPO_LIMIT) {
      return badRequest(`Inspiration gallery is limited to ${INSPO_LIMIT} images`)
    }

    const { data, error } = await supabase
      .from('inspo_gallery')
      .insert({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        image_url,
        caption: caption ?? null,
        tags: tags ?? [],
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

// DELETE /api/couple/inspo?id=xxx — delete an inspo image
export async function DELETE(req: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const id = req.nextUrl.searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('inspo_gallery')
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
