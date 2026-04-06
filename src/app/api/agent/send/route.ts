import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { sendEmail } from '@/lib/services/gmail'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST — Compose and send a new email
//   Body: { to: string, subject: string, body: string }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { to, subject, body } = await request.json()

    if (!to || typeof to !== 'string') {
      return NextResponse.json({ error: 'Missing "to" address' }, { status: 400 })
    }
    if (!body || typeof body !== 'string') {
      return NextResponse.json({ error: 'Missing email body' }, { status: 400 })
    }

    const sentMessageId = await sendEmail(
      auth.venueId,
      to,
      subject || '(No subject)',
      body
    )

    if (!sentMessageId) {
      return NextResponse.json(
        { error: 'Failed to send. Check Gmail connection.' },
        { status: 502 }
      )
    }

    // Log the outbound interaction
    const supabase = createServiceClient()
    await supabase.from('interactions').insert({
      venue_id: auth.venueId,
      type: 'email',
      direction: 'outbound',
      subject: subject || '(No subject)',
      body_preview: body.slice(0, 200),
      full_body: body,
      gmail_message_id: sentMessageId,
      timestamp: new Date().toISOString(),
    })

    return NextResponse.json({ success: true, messageId: sentMessageId })
  } catch (err) {
    console.error('[api/agent/send] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
