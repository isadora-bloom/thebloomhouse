import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/portal/finalization
// Table: section_finalisations (id, venue_id, wedding_id, section_name,
//        couple_signed_off, couple_signed_off_at, couple_signed_off_by,
//        staff_signed_off, staff_signed_off_at, staff_signed_off_by, created_at)
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const weddingId = searchParams.get('wedding_id')

    if (!weddingId) return badRequest('wedding_id query parameter is required')

    const supabase = createServiceClient()

    // Verify wedding belongs to this venue
    const { data: wedding, error: wErr } = await supabase
      .from('weddings')
      .select('id')
      .eq('id', weddingId)
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    if (wErr) throw wErr
    if (!wedding) return badRequest('Wedding not found')

    const { data, error } = await supabase
      .from('section_finalisations')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', weddingId)
      .order('created_at', { ascending: true })

    if (error) throw error

    return NextResponse.json({ data: data ?? [] })
  } catch (error) {
    return serverError(error)
  }
}

// ---- PATCH ---- staff signs off on a section
export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id, section_name, wedding_id } = body as {
      id?: string
      section_name?: string
      wedding_id?: string
    }

    if (!wedding_id) return badRequest('wedding_id is required')
    if (!section_name && !id) return badRequest('section_name or id is required')

    const supabase = createServiceClient()

    // Build the match filter
    let query = supabase
      .from('section_finalisations')
      .update({
        staff_signed_off: true,
        staff_signed_off_at: new Date().toISOString(),
        staff_signed_off_by: auth.userId,
      })
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', wedding_id)

    if (id) {
      query = query.eq('id', id)
    } else if (section_name) {
      query = query.eq('section_name', section_name)
    }

    const { data, error } = await query.select().single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (error) {
    return serverError(error)
  }
}
