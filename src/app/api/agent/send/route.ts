import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { sendEmail } from '@/lib/services/email/gmail'
import { createServiceClient } from '@/lib/supabase/service'
import { appendAIDisclosureWithVersion, fetchDisclosureContext } from '@/lib/services/brain/ai-disclosure'
import { updateThreadLifecycleFolder } from '@/lib/services/inbox/lifecycle'
import { isUnsendableAddress } from '@/lib/services/identity/body-extract'

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

    // 2026-05-11 live-customer fix: refuse any unsendable address.
    // Covers .invalid placeholders, .test/.example/.localhost, no-reply
    // local parts, and malformed values. See isUnsendableAddress JSDoc
    // for the full class.
    if (isUnsendableAddress(to)) {
      return NextResponse.json(
        {
          error: 'needs_real_address',
          message: 'This lead has no routable email address yet — find a real address on their listing platform profile or wait for a follow-up reply before sending.',
        },
        { status: 422 },
      )
    }

    // Enforce AI disclosure on every outbound Sage message. Migration 300:
    // the disclosure footer no longer carries a visible marker — idempotency
    // moved to interactions.disclosure_version. Manual coordinator sends
    // always stamp 'v4' on the interaction we insert below.
    const disclosureCtx = await fetchDisclosureContext(auth.venueId)
    const { body: bodyWithDisclosure, disclosureVersion } =
      appendAIDisclosureWithVersion(body, disclosureCtx, null)

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
    // signal-class-justified: outbound venue-side sends are not lead signals
    // html-stripped-justified: outbound coordinator/AI sends are
    //   plain-text composed in the coordinator UI + appended disclosure;
    //   no inbound HTML to strip.
    const supabase = createServiceClient()
    const { data: insertedRow } = await supabase
      .from('interactions')
      .insert({
        venue_id: auth.venueId,
        type: 'email',
        direction: 'outbound',
        subject: subject || '(No subject)',
        body_preview: bodyWithDisclosure.slice(0, 200),
        full_body: bodyWithDisclosure,
        gmail_message_id: sentMessageId,
        timestamp: new Date().toISOString(),
        signal_class: 'unclassified',
        // Migration 300: persist the disclosure version stamp so future
        // appendAIDisclosureWithVersion calls on this thread skip re-append.
        disclosure_version: disclosureVersion,
      })
      .select('id, gmail_thread_id')
      .single()

    // Inbox lifecycle folder (mig 242). A coordinator-composed cold
    // outbound starts a thread that is, by definition, not a 'new
    // inquiry' (it has venue-side outbound). Best-effort.
    if (insertedRow?.id) {
      try {
        await updateThreadLifecycleFolder({
          supabase,
          venueId: auth.venueId,
          threadId: (insertedRow.gmail_thread_id as string | null) ?? null,
          interactionId: insertedRow.id as string,
        })
      } catch { /* non-fatal */ }
    }

    return NextResponse.json({ success: true, messageId: sentMessageId })
  } catch (err) {
    console.error('[api/agent/send] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
