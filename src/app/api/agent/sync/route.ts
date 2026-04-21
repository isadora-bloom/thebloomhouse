import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { fetchNewEmails } from '@/lib/services/gmail'
import { processIncomingEmail } from '@/lib/services/email-pipeline'

// Vercel serverless cap — 300s is the max for Pro, 10s is the default
// hobby limit. This route fans out Gmail fetches × classifier calls, so
// give it the whole budget and chunk at the caller level.
export const maxDuration = 300

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

export async function POST(req: Request) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const venueId = auth.venueId
    if (!venueId) {
      return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })
    }

    // Optional ?days=N triggers a backfill: ignore last_history_id and
    // pull newer_than:Nd via Gmail search. Cap per-call at a chunk we can
    // plausibly process inside the 300s window (classifier is ~1-2s per
    // message). The UI loops until `done` is true.
    const url = new URL(req.url)
    const daysParam = Number(url.searchParams.get('days') ?? '')
    const days = Number.isFinite(daysParam) && daysParam > 0
      ? Math.min(365, Math.floor(daysParam))
      : undefined
    const chunkParam = Number(url.searchParams.get('chunk') ?? '')
    const chunk = Number.isFinite(chunkParam) && chunkParam > 0
      ? Math.min(200, Math.floor(chunkParam))
      : days ? 50 : 50 // 50 per call is ~60-90s of classifier work

    const newEmails = await fetchNewEmails(venueId, chunk, days ? { sinceDays: days } : undefined)

    let processed = 0
    let outbound = 0
    let inquiries = 0
    let ignored = 0
    let errors = 0

    // Soft time budget — bail out before Vercel pulls the plug so the UI
    // can show progress and the user can click again to continue.
    const startedAt = Date.now()
    const budgetMs = 270_000 // 4.5 min, leaving 30s headroom under maxDuration

    for (const email of newEmails) {
      if (Date.now() - startedAt > budgetMs) break
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
          if (result.interactionId === null) outbound++
          else ignored++
        }
      } catch (err) {
        errors++
        console.error('[api/agent/sync] processIncomingEmail error:', err)
      }
    }

    // done=true means this call got through every email Gmail returned
    // (either we processed them all, or Gmail had no more to give us).
    // If fetched === chunk, there's likely more — keep looping at the UI.
    const done = newEmails.length < chunk || processed === newEmails.length

    return NextResponse.json({
      success: true,
      fetched: newEmails.length,
      processed,
      inquiries,
      outbound,
      ignored,
      errors,
      done,
    })
  } catch (err) {
    console.error('[api/agent/sync] POST error:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
