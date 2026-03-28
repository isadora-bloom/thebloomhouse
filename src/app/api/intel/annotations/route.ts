import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List annotations
//   ?type=system_detected|proactive|reactive|anomaly_response
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const annotationType = searchParams.get('type')

    const supabase = createServiceClient()

    let q = supabase
      .from('annotations')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('period_start', { ascending: false })

    if (annotationType) q = q.eq('annotation_type', annotationType)

    const { data: annotations, error } = await q
    if (error) return serverError(error)

    return NextResponse.json({ annotations: annotations ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// POST — Create an annotation
//   Body: { annotation_type, period_start, period_end, title, description,
//           affects_metrics, response_category, exclude_from_patterns }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const {
      annotation_type, period_start, period_end,
      title, description, affects_metrics,
      response_category, exclude_from_patterns,
    } = body

    if (!title) return badRequest('title is required')
    if (!annotation_type) return badRequest('annotation_type is required')

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('annotations')
      .insert({
        venue_id: auth.venueId,
        annotation_type,
        period_start: period_start ?? null,
        period_end: period_end ?? null,
        title,
        description: description ?? null,
        affects_metrics: affects_metrics ?? [],
        response_category: response_category ?? null,
        exclude_from_patterns: exclude_from_patterns ?? false,
        created_by: auth.userId,
      })
      .select()
      .single()

    if (error) return serverError(error)
    return NextResponse.json({ annotation: data }, { status: 201 })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// DELETE — Delete an annotation by id (query param)
// ---------------------------------------------------------------------------

export async function DELETE(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const id = searchParams.get('id')
    if (!id) return badRequest('id query param is required')

    const supabase = createServiceClient()
    const { error } = await supabase
      .from('annotations')
      .delete()
      .eq('id', id)
      .eq('venue_id', auth.venueId)

    if (error) return serverError(error)
    return NextResponse.json({ success: true })
  } catch (err) {
    return serverError(err)
  }
}
