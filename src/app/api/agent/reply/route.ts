import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { sendEmail } from '@/lib/services/gmail'
import { createServiceClient } from '@/lib/supabase/service'
import { appendAIDisclosure, fetchDisclosureContext } from '@/lib/services/ai-disclosure'

// ---------------------------------------------------------------------------
// POST — Reply to an existing email thread
//   Body: { interactionId: string, body: string }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { interactionId, body } = await request.json()

    if (!interactionId || typeof interactionId !== 'string') {
      return NextResponse.json({ error: 'Missing interactionId' }, { status: 400 })
    }
    if (!body || typeof body !== 'string') {
      return NextResponse.json({ error: 'Missing reply body' }, { status: 400 })
    }

    const supabase = createServiceClient()

    // Look up the original interaction to get thread info and recipient
    const { data: interaction, error: fetchErr } = await supabase
      .from('interactions')
      .select('id, subject, gmail_thread_id, person_id, venue_id, people!interactions_person_id_fkey(email)')
      .eq('id', interactionId)
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    if (fetchErr || !interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 })
    }

    const recipientEmail = (interaction as any).people?.email
    if (!recipientEmail) {
      return NextResponse.json({ error: 'No recipient email found for this thread' }, { status: 400 })
    }

    const subject = interaction.subject?.startsWith('Re: ')
      ? interaction.subject
      : `Re: ${interaction.subject || '(No subject)'}`

    // Enforce AI disclosure — idempotent, so safe if the body already
    // contains the marker (e.g. from a quoted prior thread).
    const disclosureCtx = await fetchDisclosureContext(auth.venueId)
    const bodyWithDisclosure = appendAIDisclosure(body, disclosureCtx)

    const sentMessageId = await sendEmail(
      auth.venueId,
      recipientEmail,
      subject,
      bodyWithDisclosure,
      interaction.gmail_thread_id || undefined
    )

    if (!sentMessageId) {
      return NextResponse.json(
        { error: 'Failed to send reply. Check Gmail connection.' },
        { status: 502 }
      )
    }

    // Log the outbound reply (store the version the recipient actually saw)
    await supabase.from('interactions').insert({
      venue_id: auth.venueId,
      wedding_id: null,
      person_id: interaction.person_id,
      type: 'email',
      direction: 'outbound',
      subject,
      body_preview: bodyWithDisclosure.slice(0, 200),
      full_body: bodyWithDisclosure,
      gmail_thread_id: interaction.gmail_thread_id,
      gmail_message_id: sentMessageId,
      timestamp: new Date().toISOString(),
    })

    return NextResponse.json({ success: true, messageId: sentMessageId })
  } catch (err) {
    console.error('[api/agent/reply] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
