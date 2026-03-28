import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getCoupleAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/couple/messages
// Table: messages (id, venue_id, wedding_id, sender_id, sender_role, content, read_at)
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)

    // Unread count mode
    if (searchParams.get('unread') === 'true') {
      const { count, error } = await supabase
        .from('messages')
        .select('*', { count: 'exact', head: true })
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)
        .neq('sender_role', 'couple')
        .is('read_at', null)

      if (error) throw error
      return NextResponse.json({ data: { unread: count ?? 0 } })
    }

    // Full message list
    const { data: messages, error } = await supabase
      .from('messages')
      .select('*')
      .eq('venue_id', auth.venueId)
      .eq('wedding_id', auth.weddingId)
      .order('created_at', { ascending: true })

    if (error) throw error

    // Mark unread messages TO the couple as read
    const unreadIds = (messages ?? [])
      .filter((m) => m.sender_role !== 'couple' && !m.read_at)
      .map((m) => m.id)

    if (unreadIds.length > 0) {
      const { error: updateErr } = await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .in('id', unreadIds)
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', auth.weddingId)

      if (updateErr) throw updateErr
    }

    return NextResponse.json({ data: messages ?? [] })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST ----
export async function POST(request: NextRequest) {
  const auth = await getCoupleAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { content } = body
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return badRequest('content is required')
    }

    const supabase = createServiceClient()

    const { data, error } = await supabase
      .from('messages')
      .insert({
        venue_id: auth.venueId,
        wedding_id: auth.weddingId,
        sender_id: auth.userId,
        sender_role: 'couple',
        content: content.trim(),
      })
      .select()
      .single()

    if (error) throw error
    return NextResponse.json({ data }, { status: 201 })
  } catch (error) {
    return serverError(error)
  }
}
