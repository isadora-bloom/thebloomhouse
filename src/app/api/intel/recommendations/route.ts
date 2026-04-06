import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// GET — List recommendations for the authenticated venue
// Optional query param: ?status=pending|applied|dismissed
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const status = request.nextUrl.searchParams.get('status')

    let query = supabase
      .from('trend_recommendations')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })

    if (status) {
      query = query.eq('status', status)
    }

    const { data, error } = await query

    if (error) return serverError(error)

    return NextResponse.json({ recommendations: data ?? [] })
  } catch (err) {
    console.error('[api/intel/recommendations] GET error:', err)
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Update recommendation status (apply or dismiss)
// Body: { recommendationId: string, status: 'applied' | 'dismissed' }
//   OR: { id: string, status: 'applied' | 'dismissed' } (alternate format)
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    // Support both { recommendationId } and { id } field names
    const recommendationId: string = body.recommendationId ?? body.id
    const status: string = body.status

    if (!recommendationId || !status) {
      return NextResponse.json(
        { error: 'Missing recommendationId and status' },
        { status: 400 }
      )
    }

    if (!['applied', 'dismissed'].includes(status)) {
      return NextResponse.json(
        { error: 'Status must be "applied" or "dismissed"' },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const updates: Record<string, unknown> = { status }
    if (status === 'applied') updates.applied_at = new Date().toISOString()
    if (status === 'dismissed') updates.dismissed_at = new Date().toISOString()

    // If outcome_notes provided, merge into supporting_data JSONB
    const outcomeNotes: string | undefined = body.outcome_notes
    if (outcomeNotes) {
      const { data: existing } = await supabase
        .from('trend_recommendations')
        .select('supporting_data')
        .eq('id', recommendationId)
        .eq('venue_id', auth.venueId)
        .maybeSingle()

      const existingData = (existing?.supporting_data ?? {}) as Record<string, unknown>
      updates.supporting_data = { ...existingData, outcome_notes: outcomeNotes }
    }

    const { error } = await supabase
      .from('trend_recommendations')
      .update(updates)
      .eq('id', recommendationId)
      .eq('venue_id', auth.venueId)

    if (error) return serverError(error)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[api/intel/recommendations] PATCH error:', err)
    return serverError(err)
  }
}
