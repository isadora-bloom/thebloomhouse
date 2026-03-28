import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

const ALLOWED_FIELDS = [
  'time', 'duration_minutes', 'title', 'description',
  'category', 'location', 'vendor_id', 'sort_order',
] as const

function pick(body: Record<string, unknown>, fields: readonly string[]) {
  const result: Record<string, unknown> = {}
  for (const key of fields) {
    if (key in body) result[key] = body[key]
  }
  return result
}

// GET — list all timeline items
export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('timeline')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('sort_order', { ascending: true })
      .order('time', { ascending: true })

    if (error) throw error
    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}

// POST — create timeline item
export async function POST(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const fields = pick(body, ALLOWED_FIELDS)
    if (!fields.title) return badRequest('title is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('timeline')
      .insert({
        ...fields,
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// PATCH — update timeline item by id
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { id } = body
    if (!id) return badRequest('id is required')

    const fields = pick(body, ALLOWED_FIELDS)
    if (Object.keys(fields).length === 0) return badRequest('No fields to update')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('timeline')
      .update({ ...fields, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}

// DELETE — delete timeline item by id (query param)
export async function DELETE(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('timeline')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
