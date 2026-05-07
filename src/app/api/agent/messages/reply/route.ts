import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { getPlatformAuth, assertCanAccessVenue, forbidden } from '@/lib/api/auth-helpers'

/**
 * POST /api/agent/messages/reply (Tier-B #58C)
 *
 * Coordinator-side endpoint for replying to a couple's in-portal
 * message. Lives separately from /api/couple/messages because it
 * uses platform auth (coordinator) and writes with sender_role
 * 'coordinator'. The couple's portal Messages page reads the
 * messages table and the new row appears in their thread.
 *
 * Mirrored into interactions with type='portal_chat' direction='outbound'
 * so the agent-inbox view shows the back-and-forth in one place.
 *
 * Body: { weddingId: string, content: string }
 */
export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = (await request.json().catch(() => null)) as
    | { weddingId?: string; content?: string }
    | null

  if (!body?.weddingId || !body?.content) {
    return NextResponse.json(
      { error: 'weddingId and content are required' },
      { status: 400 },
    )
  }
  const trimmed = body.content.trim()
  if (!trimmed) {
    return NextResponse.json({ error: 'content is empty' }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Resolve the wedding's venue + verify access.
  const { data: wedding } = await supabase
    .from('weddings')
    .select('venue_id')
    .eq('id', body.weddingId)
    .maybeSingle()
  if (!wedding) {
    return NextResponse.json({ error: 'Wedding not found' }, { status: 404 })
  }
  const access = await assertCanAccessVenue(auth, wedding.venue_id as string)
  if (!access.ok) return forbidden(access.reason)

  const { data: insertedMessage, error: msgErr } = await supabase
    .from('messages')
    .insert({
      venue_id: wedding.venue_id,
      wedding_id: body.weddingId,
      sender_id: auth.userId,
      sender_role: 'coordinator',
      content: trimmed,
    })
    .select()
    .single()

  if (msgErr) {
    console.error('[agent/messages/reply] message insert failed:', msgErr)
    return NextResponse.json({ error: 'Failed to send' }, { status: 500 })
  }

  // Mirror the outbound side into interactions for the inbox thread view.
  // Fire-and-forget; the messages row is the source of truth.
  void supabase
    .from('interactions')
    .insert({
      venue_id: wedding.venue_id,
      wedding_id: body.weddingId,
      type: 'portal_chat',
      direction: 'outbound',
      subject: 'Reply to couple',
      body_preview: trimmed.length > 240 ? trimmed.slice(0, 240) + '…' : trimmed,
      full_body: trimmed,
    })
    .then(({ error: mirrorErr }) => {
      if (mirrorErr) {
        console.warn(
          '[agent/messages/reply] inbox mirror failed (non-fatal):',
          mirrorErr.message,
        )
      }
    })

  return NextResponse.json({ data: insertedMessage }, { status: 201 })
}
