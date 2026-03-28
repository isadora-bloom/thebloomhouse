import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — List error logs for venue
//   ?resolved=true|false  (default: all)
//   Order by created_at desc. Limit 100.
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const { searchParams } = new URL(request.url)
    const resolved = searchParams.get('resolved')
    const supabase = createServiceClient()

    let query = supabase
      .from('error_logs')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })
      .limit(100)

    if (resolved === 'true') {
      query = query.eq('resolved', true)
    } else if (resolved === 'false') {
      query = query.eq('resolved', false)
    }

    const { data, error } = await query

    if (error) throw error
    return NextResponse.json({ errors: data ?? [] })
  } catch (err) {
    return serverError(err)
  }
}

// ---------------------------------------------------------------------------
// PATCH — Mark error as resolved
//   Body: { id }
//   Sets resolved=true, resolved_by=userId, resolved_at=now()
// ---------------------------------------------------------------------------

export async function PATCH(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { id } = body

    if (!id || typeof id !== 'string') {
      return badRequest('Missing or invalid id')
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('error_logs')
      .update({
        resolved: true,
        resolved_by: auth.userId,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('venue_id', auth.venueId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ error_log: data })
  } catch (err) {
    return serverError(err)
  }
}
