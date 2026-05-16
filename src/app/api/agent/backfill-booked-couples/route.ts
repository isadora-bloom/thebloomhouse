import { NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

// ---------------------------------------------------------------------------
// Historical Gmail backfill — enqueue + status.
//
// POST  /api/agent/backfill-booked-couples
//   Enqueues the background job: 12 months of the whole inbox, then a
//   3-year per-couple name+email search for every booked couple. The
//   actual work is done by the email_poll cron (every 5 min) via
//   drainGmailBackfill — so it survives the coordinator closing the tab,
//   the laptop sleeping, or a network blip. See historical-backfill.ts.
//
// GET   /api/agent/backfill-booked-couples
//   Returns the current job state for the UI to poll.
// ---------------------------------------------------------------------------

export async function POST() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const supabase = createServiceClient()

  // Don't double-enqueue a job that's already running.
  const { data: venue } = await supabase
    .from('venues')
    .select('gmail_backfill_status')
    .eq('id', venueId)
    .maybeSingle()
  if (venue?.gmail_backfill_status === 'running' || venue?.gmail_backfill_status === 'pending') {
    return NextResponse.json({ ok: true, alreadyRunning: true, status: venue.gmail_backfill_status })
  }

  const { error } = await supabase
    .from('venues')
    .update({
      gmail_backfill_status: 'pending',
      gmail_backfill_phase: 'general',
      gmail_backfill_cursor: 0,
      gmail_backfill_emails: 0,
      gmail_backfill_updated_at: new Date().toISOString(),
    })
    .eq('id', venueId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ ok: true, status: 'pending' })
}

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const venueId = auth.venueId
  if (!venueId) return NextResponse.json({ error: 'No venue in scope' }, { status: 400 })

  const supabase = createServiceClient()
  const { data: venue } = await supabase
    .from('venues')
    .select('gmail_backfill_status, gmail_backfill_phase, gmail_backfill_cursor, gmail_backfill_emails, gmail_backfill_updated_at')
    .eq('id', venueId)
    .maybeSingle()

  return NextResponse.json({
    status: venue?.gmail_backfill_status ?? null,
    phase: venue?.gmail_backfill_phase ?? null,
    cursor: venue?.gmail_backfill_cursor ?? 0,
    emails: venue?.gmail_backfill_emails ?? 0,
    updatedAt: venue?.gmail_backfill_updated_at ?? null,
  })
}
