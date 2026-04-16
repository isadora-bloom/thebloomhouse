import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { getOAuthUrl, handleOAuthCallback, getGmailClient } from '@/lib/services/gmail'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — Two modes:
//   ?action=auth-url&redirectUri=URL  → returns { url: '...' }
//   (no action)                        → returns { connected, email?, lastSync?, error? }
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
    const action = searchParams.get('action')

    // --- Generate OAuth URL ---
    if (action === 'auth-url') {
      const redirectUri = searchParams.get('redirectUri')

      if (!redirectUri) {
        return NextResponse.json(
          { error: 'Missing redirectUri query parameter' },
          { status: 400 }
        )
      }

      const url = getOAuthUrl(auth.venueId, redirectUri)

      if (!url) {
        return NextResponse.json(
          { error: 'Gmail integration is not configured. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.' },
          { status: 503 }
        )
      }

      return NextResponse.json({ url })
    }

    // --- Check connection status ---
    const supabase = createServiceClient()

    // Check if tokens exist
    const { data: config } = await supabase
      .from('venue_config')
      .select('gmail_tokens, coordinator_email')
      .eq('venue_id', auth.venueId)
      .single()

    if (!config?.gmail_tokens) {
      return NextResponse.json({ connected: false })
    }

    // Tokens exist — try to verify with Gmail API
    let email: string | undefined
    try {
      const gmail = await getGmailClient(auth.venueId)
      if (gmail) {
        const profile = await gmail.users.getProfile({ userId: 'me' })
        email = profile.data.emailAddress ?? undefined
      }
    } catch (verifyErr) {
      console.warn('[api/agent/gmail] Token verification failed:', verifyErr)
      // Tokens exist but may be invalid — still report as connected
      // so the user can see the state and choose to disconnect
      email = config.coordinator_email ?? undefined
    }

    // Get last sync time
    const { data: syncState } = await supabase
      .from('email_sync_state')
      .select('last_sync_at, status, error_message')
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    return NextResponse.json({
      connected: true,
      email: email ?? config.coordinator_email ?? undefined,
      lastSync: syncState?.last_sync_at ?? null,
      syncStatus: syncState?.status ?? null,
      error: syncState?.error_message ?? undefined,
    })
  } catch (err) {
    console.error('[api/agent/gmail] GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// POST — Handle Gmail OAuth callback
//   Body: { code: string, redirectUri: string }
// ---------------------------------------------------------------------------

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await request.json()
    const { code, redirectUri } = body

    if (!code || typeof code !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid authorization code' },
        { status: 400 }
      )
    }

    if (!redirectUri || typeof redirectUri !== 'string') {
      return NextResponse.json(
        { error: 'Missing or invalid redirectUri' },
        { status: 400 }
      )
    }

    const success = await handleOAuthCallback(auth.venueId, code, redirectUri)

    if (!success) {
      return NextResponse.json(
        { error: 'Failed to complete Gmail OAuth flow' },
        { status: 500 }
      )
    }

    // Fetch the connected email + sync info to return
    const supabase = createServiceClient()

    // Try to get the email from the profile
    let email: string | undefined
    try {
      const gmail = await getGmailClient(auth.venueId)
      if (gmail) {
        const profile = await gmail.users.getProfile({ userId: 'me' })
        email = profile.data.emailAddress ?? undefined

        // Also store it as coordinator_email for quick lookups
        if (email) {
          await supabase
            .from('venue_config')
            .update({ coordinator_email: email })
            .eq('venue_id', auth.venueId)
        }
      }
    } catch {
      // Best effort — email retrieval is not critical here
    }

    const { data: syncState } = await supabase
      .from('email_sync_state')
      .select('last_sync_at')
      .eq('venue_id', auth.venueId)
      .maybeSingle()

    return NextResponse.json({
      success: true,
      connected: true,
      email: email ?? undefined,
      lastSync: syncState?.last_sync_at ?? null,
    })
  } catch (err) {
    console.error('[api/agent/gmail] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------------------------------------------------------------------------
// DELETE — Disconnect Gmail (clear tokens)
// ---------------------------------------------------------------------------

export async function DELETE() {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = createServiceClient()

    // Clear Gmail tokens from venue_config
    const { error: tokenError } = await supabase
      .from('venue_config')
      .update({ gmail_tokens: null })
      .eq('venue_id', auth.venueId)

    if (tokenError) {
      console.error('[api/agent/gmail] Failed to clear tokens:', tokenError.message)
      return NextResponse.json({ error: 'Failed to disconnect Gmail' }, { status: 500 })
    }

    // Clear email sync state
    await supabase
      .from('email_sync_state')
      .delete()
      .eq('venue_id', auth.venueId)

    console.log(`[api/agent/gmail] Gmail disconnected for venue ${auth.venueId}`)

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[api/agent/gmail] DELETE error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
