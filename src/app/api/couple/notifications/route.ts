import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/couple/notifications
// Table: couple_notifications (id, venue_id, wedding_id, type, title, body, link, read)
// GET                      — recent notifications for this wedding
// GET ?unread=true         — { unread: <count> }
// POST { id }              — mark one read
// POST { all: true }       — mark all read
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)

    if (searchParams.get('unread') === 'true') {
      const { count, error } = await supabase
        .from('couple_notifications')
        .select('*', { count: 'exact', head: true })
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .eq('read', false)
      if (error) throw error
      return NextResponse.json({ data: { unread: count ?? 0 } })
    }

    const { data, error } = await supabase
      .from('couple_notifications')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('created_at', { ascending: false })
      .limit(50)
    if (error) throw error

    return NextResponse.json({ data: data ?? [] })
  } catch (error) {
    return serverError(error)
  }
}

export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json().catch(() => ({}))
    const supabase = createServiceClient()

    let query = supabase
      .from('couple_notifications')
      .update({ read: true })
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .eq('read', false)

    // Mark a single notification read unless { all: true } was passed.
    if (!body.all) {
      if (!body.id) return NextResponse.json({ error: 'id or all required' }, { status: 400 })
      query = query.eq('id', body.id)
    }

    const { error } = await query
    if (error) throw error
    return NextResponse.json({ data: { ok: true } })
  } catch (error) {
    return serverError(error)
  }
}
