import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { fetchNewEmails } from '@/lib/services/gmail'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// POST — Trigger an email sync for the authenticated venue
//
// Pulls new emails from Gmail via the history API (or list API for
// initial sync). Stores them in the interactions table and updates
// email_sync_state.
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const venueId = auth.venueId

    // Fetch new emails from Gmail
    const newEmails = await fetchNewEmails(venueId)

    // Store each new email as an interaction (skip if messageId already exists)
    const supabase = createServiceClient()
    let synced = 0

    for (const email of newEmails) {
      // Check if this message already exists
      const { data: existing } = await supabase
        .from('interactions')
        .select('id')
        .eq('venue_id', venueId)
        .eq('gmail_message_id', email.messageId)
        .maybeSingle()

      if (existing) continue

      const { error } = await supabase.from('interactions').insert({
        venue_id: venueId,
        gmail_message_id: email.messageId,
        gmail_thread_id: email.threadId,
        from_email: email.from,
        to_email: email.to,
        subject: email.subject,
        body_preview: email.body.slice(0, 500),
        body_full: email.body,
        direction: 'inbound',
        timestamp: email.date ? new Date(email.date).toISOString() : new Date().toISOString(),
        is_read: false,
      })

      if (!error) synced++
    }

    return NextResponse.json({
      success: true,
      fetched: newEmails.length,
      synced,
    })
  } catch (err) {
    console.error('[api/agent/sync] POST error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
