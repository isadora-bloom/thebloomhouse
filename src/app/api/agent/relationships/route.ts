import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List all relationships for venue
//   Joins with people for names on both sides
//   Order by created_at desc
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('relationships')
      .select(`
        id,
        relationship_type,
        notes,
        created_at,
        person_a:person_a_id(id, first_name, last_name, email, role),
        person_b:person_b_id(id, first_name, last_name, email, role)
      `)
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })

    if (error) throw error
    return NextResponse.json({ relationships: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Create a relationship
//   Body: { person_a_id, person_b_id, relationship_type, notes? }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { person_a_id, person_b_id, relationship_type, notes } = body

    if (!person_a_id || typeof person_a_id !== 'string') {
      return badRequest('Missing or invalid person_a_id')
    }
    if (!person_b_id || typeof person_b_id !== 'string') {
      return badRequest('Missing or invalid person_b_id')
    }
    if (!relationship_type || typeof relationship_type !== 'string') {
      return badRequest('Missing or invalid relationship_type')
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('relationships')
      .insert({
        venue_id: auth.venueId,
        person_a_id,
        person_b_id,
        relationship_type,
        notes: notes ?? null,
      })
      .select(`
        id,
        relationship_type,
        notes,
        created_at,
        person_a:person_a_id(id, first_name, last_name, email, role),
        person_b:person_b_id(id, first_name, last_name, email, role)
      `)
      .single()

    if (error) throw error
    return NextResponse.json({ relationship: data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// DELETE — Delete a relationship by id
//   ?id=<relationship_id>
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')

    if (!id) return badRequest('Missing id query parameter')

    const supabase = createServiceClient()

    const { error } = await supabase
      .from('relationships')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)

    if (error) throw error
    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
