import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

const DEFAULT_SECTIONS = [
  'timeline', 'ceremony', 'guests', 'seating', 'vendors',
  'beauty', 'transportation', 'rehearsal', 'rooms', 'decor',
  'allergies', 'staffing', 'bar', 'guest_care', 'final_review',
]

// GET — list finalization sections, auto-create defaults if none exist
export async function GET() {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('section_finalisations')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)

    if (error) throw error

    // Auto-create default sections if no rows exist
    if (!data || data.length === 0) {
      const rows = DEFAULT_SECTIONS.map((section_name) => ({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        section_name,
        couple_signed_off: false,
        staff_signed_off: false,
      }))

      const { data: created, error: insertError } = await supabase
        .from('section_finalisations')
        .insert(rows)
        .select()

      if (insertError) throw insertError
      return NextResponse.json({ data: created })
    }

    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}

// PATCH — couple signs off on a section
export async function PATCH(request: NextRequest) {
  try {
    const auth = await getCoupleAuth()
    if (!auth) return unauthorized()

    const body = await request.json()
    const { section_name } = body as { section_name?: string }
    if (!section_name) return badRequest('section_name is required')

    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from('section_finalisations')
      .update({
        couple_signed_off: true,
        couple_signed_off_at: new Date().toISOString(),
        couple_signed_off_by: auth.userId,
      })
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .eq('section_name', section_name)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data })
  } catch (err) {
    return serverError(err)
  }
}
