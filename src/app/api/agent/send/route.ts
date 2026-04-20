import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { sendEmail } from '@/lib/services/gmail'
import { createServiceClient } from '@/lib/supabase/service'
import { appendAIDisclosure, fetchDisclosureContext } from '@/lib/services/ai-disclosure'

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

    // Enforce AI disclosure on every outbound Sage message. Context carries
    // the per-venue Sage name / role / venue name so the footer is
    // personalised. See src/lib/services/ai-disclosure.ts.
    const disclosureCtx = await fetchDisclosureContext(auth.venueId)
    const bodyWithDisclosure = appendAIDisclosure(body, disclosureCtx)

    const sentMessageId = await sendEmail(
      auth.venueId,
      to,
      subject || '(No subject)',
      bodyWithDisclosure
    )

    if (!sentMessageId) {
      return NextResponse.json(
        { error: 'Failed to send. Check Gmail connection.' },
        { status: 502 }
      )
    }

    // Log the outbound interaction (store the disclosed version — that's
    // what the recipient actually received)
    const supabase = createServiceClient()
    await supabase.from('interactions').insert({
      venue_id: auth.venueId,
      type: 'email',
      direction: 'outbound',
      subject: subject || '(No subject)',
      body_preview: bodyWithDisclosure.slice(0, 200),
      full_body: bodyWithDisclosure,
      gmail_message_id: sentMessageId,
      timestamp: new Date().toISOString(),
    })

    return NextResponse.json({ success: true, messageId: sentMessageId })
  } catch (err) {
    console.error('[api/agent/send] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
