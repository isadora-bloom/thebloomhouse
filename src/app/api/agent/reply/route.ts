import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { sendEmail } from '@/lib/services/email/gmail'
import { createServiceClient } from '@/lib/supabase/service'
import { appendAIDisclosureWithVersion, fetchDisclosureContext } from '@/lib/services/brain/ai-disclosure'
import { updateThreadLifecycleFolder } from '@/lib/services/inbox/lifecycle'
import { isUnsendableAddress } from '@/lib/services/identity/body-extract'

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

    // Look up the original interaction to get thread info and recipient.
    // Migration 300: also fetch the inbound's from_email (best routable
    // address when people.email is a synthetic placeholder), plus any
    // existing thread-level disclosure_version so we don't re-append.
    const { data: interaction, error: fetchErr } = await supabase
      .from('interactions')
      .select('id, subject, gmail_thread_id, person_id, venue_id, from_email, people!interactions_person_id_fkey(email)')
      .eq('id', interactionId)
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    if (fetchErr || !interaction) {
      return NextResponse.json({ error: 'Interaction not found' }, { status: 404 })
    }

    // 2026-05-11 live-customer fix: prefer the inbound's from_email when
    // people.email is unsendable (synthetic placeholder, no-reply local
    // part, reserved TLD). The form-relay-parsers fix anchors NEW leads
    // on the per-prospect relay where available; historical rows still
    // carry the unroutable email. The thread's actual from_email is
    // usually the routable one.
    const peopleEmail = (interaction as any).people?.email as string | undefined
    const fromEmail = (interaction.from_email as string | null) ?? undefined
    let recipientEmail: string | undefined
    if (peopleEmail && !isUnsendableAddress(peopleEmail)) {
      recipientEmail = peopleEmail
    } else if (fromEmail && !isUnsendableAddress(fromEmail)) {
      recipientEmail = fromEmail
    } else if (peopleEmail) {
      // Both unsendable. Surface the operator-friendly error rather
      // than ship a guaranteed bounce.
      return NextResponse.json(
        {
          error: 'needs_real_address',
          message: 'This thread has no routable email address yet — open the inbound and use the listing platform reply link, or wait for the couple to send a follow-up before replying.',
        },
        { status: 422 },
      )
    } else {
      return NextResponse.json({ error: 'No recipient email found for this thread' }, { status: 400 })
    }

    const subject = interaction.subject?.startsWith('Re: ')
      ? interaction.subject
      : `Re: ${interaction.subject || '(No subject)'}`

    // Migration 300: idempotency for the disclosure footer lives on
    // interactions.disclosure_version now (not in body). Look up the
    // thread's most recent outbound to see whether a footer was already
    // shipped on this thread.
    let previousDisclosureVersion: string | null = null
    if (interaction.gmail_thread_id) {
      const { data: prior } = await supabase
        .from('interactions')
        .select('disclosure_version')
        .eq('venue_id', auth.venueId)
        .eq('gmail_thread_id', interaction.gmail_thread_id)
        .eq('direction', 'outbound')
        .not('disclosure_version', 'is', null)
        .order('timestamp', { ascending: false })
        .limit(1)
        .maybeSingle()
      previousDisclosureVersion = (prior?.disclosure_version as string | null) ?? null
    }
    const disclosureCtx = await fetchDisclosureContext(auth.venueId)
    const { body: bodyWithDisclosure, disclosureVersion } =
      appendAIDisclosureWithVersion(body, disclosureCtx, previousDisclosureVersion)

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
    // T5-Rixey-BBB: outbound venue→lead replies are unclassified for
    // attribution purposes (they're our outreach, not a lead-side
    // signal of any class).
    // signal-class-justified: outbound replies are venue-side, not lead signals
    // html-stripped-justified: outbound coordinator/AI replies are
    //   plain-text composed in the coordinator UI + appended disclosure;
    //   no inbound HTML to strip.
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
      signal_class: 'unclassified',
      // Migration 300: persist the disclosure version on the row so the
      // next reply on this thread short-circuits the footer re-append.
      disclosure_version: disclosureVersion,
    })

    // Inbox lifecycle folder (mig 242). A coordinator reply on a thread
    // promotes it out of 'new_inquiry' since outbound count just went
    // up. Best-effort — folder mis-classification must not fail the
    // user-visible send.
    try {
      await updateThreadLifecycleFolder({
        supabase,
        venueId: auth.venueId,
        threadId: (interaction.gmail_thread_id as string | null) ?? null,
      })
    } catch { /* non-fatal */ }

    return NextResponse.json({ success: true, messageId: sentMessageId })
  } catch (err) {
    console.error('[api/agent/reply] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
