import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { fetchNewEmails } from '@/lib/services/gmail'
import { processIncomingEmail } from '@/lib/services/email-pipeline'

// ---------------------------------------------------------------------------
// POST /api/agent/sync
//
// Triggers an email sync for the authenticated venue. Pulls new messages
// from every linked Gmail connection and routes each one through the
// shared pipeline (processIncomingEmail) so classification, contact
// resolution, wedding creation, direction detection, and draft
// generation all happen in one place.
//
// Why this matters: the previous version did a naked insert with
// `direction: 'inbound'` for every message and a wrong column name
// (`body_full` vs the schema's `full_body`). That skipped the classifier
// entirely, forced a second "Build pipeline" pass via reprocess-orphans,
// and stamped every outbound sent-mail (Gmail returns sent messages in
// threads too) as an inbound inquiry — which is how sage@rixeymanor.com
// ended up on the pipeline kanban as its own "couple". Routing through
// the pipeline fixes all of that at the source.
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const venueId = auth.venueId
    if (!venueId) {
      return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
    }

    const newEmails = await fetchNewEmails(venueId)

    let processed = 0
    let outbound = 0
    let inquiries = 0
    let ignored = 0
    let errors = 0

    for (const email of newEmails) {
      try {
        const result = await processIncomingEmail(venueId, {
          messageId: email.messageId,
          threadId: email.threadId,
          from: email.from,
          to: email.to,
          subject: email.subject,
          body: email.body,
          date: email.date,
          labels: email.labels,
          connectionId: email.connectionId,
        })
        processed++
        if (result.classification === 'new_inquiry' || result.classification === 'inquiry_reply') {
          inquiries++
        } else if (result.classification === 'ignore' || result.classification === 'skipped') {
          // Could be self-outbound (recorded outbound) or a filter match —
          // either way not a pipeline entry.
          if (result.interactionId === null) outbound++
          else ignored++
        }
      } catch (err) {
        errors++
        console.error('[api/agent/sync] processIncomingEmail error:', err)
      }
    }

    return NextResponse.json({
      success: true,
      fetched: newEmails.length,
      processed,
      inquiries,
      outbound,
      ignored,
      errors,
    })
  } catch (err) {
    console.error('[api/agent/sync] POST error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
