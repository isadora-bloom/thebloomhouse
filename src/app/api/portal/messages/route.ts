import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, unauthorized, badRequest, serverError } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// /api/portal/messages
// Table: messages (id, venue_id, wedding_id, sender_id, sender_role, content, read_at)
// ---------------------------------------------------------------------------

// ---- GET ----
export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const supabase = createServiceClient()
    const { searchParams } = new URL(request.url)
    const weddingId = searchParams.get('wedding_id')

    // ------------------------------------------------------------------
    // Single wedding conversation — list all messages
    // ------------------------------------------------------------------
    if (weddingId) {
      // Verify wedding belongs to this venue
      const { data: wedding, error: wErr } = await supabase
        .from('weddings')
        .select('id')
        .eq('id', weddingId)
        .eq('venue_id', auth.venueId)
        .maybeSingle()

      if (wErr) throw wErr
      if (!wedding) return badRequest('Wedding not found')

      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .eq('venue_id', auth.venueId)
        .eq('wedding_id', weddingId)
        .order('created_at', { ascending: true })

      if (error) throw error

      // Mark unread messages FROM couple as read
      const unreadIds = (messages ?? [])
        .filter((m) => m.sender_role === 'couple' && !m.read_at)
        .map((m) => m.id)

      if (unreadIds.length > 0) {
        const { error: updateErr } = await supabase
          .from('messages')
          .update({ read_at: new Date().toISOString() })
          .in('id', unreadIds)
          .eq('venue_id', auth.venueId)

        if (updateErr) throw updateErr
      }

      return NextResponse.json({ data: messages ?? [] })
    }

    // ------------------------------------------------------------------
    // Conversations list — grouped by wedding
    // ------------------------------------------------------------------

    // Get all messages for the venue, ordered by most recent first
    const { data: allMessages, error: msgErr } = await supabase
      .from('messages')
      .select('*')
      .eq('venue_id', auth.venueId)
      .order('created_at', { ascending: false })

    if (msgErr) throw msgErr

    if (!allMessages || allMessages.length === 0) {
      return NextResponse.json({ data: [] })
    }

    // Collect unique wedding ids
    const weddingIds = [...new Set(allMessages.map((m) => m.wedding_id).filter(Boolean))] as string[]

    // Fetch couple names for all weddings
    const { data: people, error: pErr } = await supabase
      .from('people')
      .select('wedding_id, first_name, last_name, role')
      .eq('venue_id', auth.venueId)
      .in('wedding_id', weddingIds)
      .in('role', ['partner1', 'partner2'])

    if (pErr) throw pErr

    // Build couple names map
    const coupleMap = new Map<string, string>()
    for (const p of people ?? []) {
      if (!p.wedding_id) continue
      const existing = coupleMap.get(p.wedding_id) ?? ''
      const name = [p.first_name, p.last_name].filter(Boolean).join(' ')
      coupleMap.set(p.wedding_id, existing ? `${existing} & ${name}` : name)
    }

    // Group messages by wedding_id — since messages are ordered desc,
    // the first message per wedding is the most recent
    const conversationMap = new Map<string, {
      wedding_id: string
      couple_names: string | null
      last_message: typeof allMessages[0]
      unread_count: number
    }>()

    for (const msg of allMessages) {
      const wId = msg.wedding_id as string
      if (!wId) continue

      const existing = conversationMap.get(wId)
      if (!existing) {
        conversationMap.set(wId, {
          wedding_id: wId,
          couple_names: coupleMap.get(wId) ?? null,
          last_message: msg,
          unread_count: msg.sender_role === 'couple' && !msg.read_at ? 1 : 0,
        })
      } else {
        if (msg.sender_role === 'couple' && !msg.read_at) {
          existing.unread_count++
        }
      }
    }

    // Convert to array — already ordered by most recent message first
    const conversations = Array.from(conversationMap.values())

    return NextResponse.json({ data: conversations })
  } catch (error) {
    return serverError(error)
  }
}

// ---- POST ----
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) return unauthorized()

  try {
    const body = await request.json()
    const { wedding_id, content } = body

    if (!wedding_id || typeof wedding_id !== 'string') {
      return badRequest('wedding_id is required')
    }
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return badRequest('content is required')
    }

    const supabase = createServiceClient()

    // Verify wedding belongs to this venue
    const { data: wedding, error: wErr } = await supabase
      .from('weddings')
      .select('id')
      .eq('id', wedding_id)
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    if (wErr) throw wErr
    if (!wedding) return badRequest('Wedding not found')

    const { data, error } = await supabase
      .from('messages')
      .insert({
        venue_id: auth.venueId,
        wedding_id,
        sender_id: auth.userId,
        sender_role: 'coordinator',
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
