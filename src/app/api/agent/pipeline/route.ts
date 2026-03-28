import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { processAllNewEmails } from '@/lib/services/email-pipeline'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// POST — Trigger email processing pipeline
//   Body: { venueId? } (optional — uses auth venue if omitted)
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json().catch(() => ({}))
    const venueId = (body.venueId as string) || auth.venueId

    // Only allow processing own venue (unless we add super-admin later)
    if (venueId !== auth.venueId) {
      return NextResponse.json(
        { error: 'Cannot process emails for a different venue' },
        { status: 403 }
      )
    }

    const summary = await processAllNewEmails(venueId)

    return NextResponse.json({ success: true, summary })
  } catch (err) {
    console.error('[api/agent/pipeline] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// GET — Pipeline status (email_sync_state + recent processing stats)
// ---------------------------------------------------------------------------

export async function GET() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()

    // Fetch email sync state
    const { data: syncState } = await supabase
      .from('email_sync_state')
      .select('*')
      .eq('venue_id', auth.venueId)
      .single()

    // Recent processing stats: count of interactions in last 24h
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

    const { count: recentInbound } = await supabase
      .from('interactions')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', auth.venueId)
      .eq('direction', 'inbound')
      .gte('timestamp', oneDayAgo)

    const { count: recentDrafts } = await supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', auth.venueId)
      .gte('created_at', oneDayAgo)

    const { count: recentAutoSent } = await supabase
      .from('drafts')
      .select('id', { count: 'exact', head: true })
      .eq('venue_id', auth.venueId)
      .eq('auto_sent', true)
      .gte('created_at', oneDayAgo)

    return NextResponse.json({
      syncState: syncState ?? null,
      recentStats: {
        inboundLast24h: recentInbound ?? 0,
        draftsLast24h: recentDrafts ?? 0,
        autoSentLast24h: recentAutoSent ?? 0,
      },
    })
  } catch (err) {
    console.error('[api/agent/pipeline] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
