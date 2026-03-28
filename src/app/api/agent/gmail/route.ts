import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { getOAuthUrl, handleOAuthCallback } from '@/lib/services/gmail'
import { getPlatformAuth } from '@/lib/api/auth-helpers'

// ---------------------------------------------------------------------------
// GET — Get Gmail OAuth URL
//   ?redirectUri=URL (required)
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const { searchParams } = new URL(request.url)
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

    // Fetch last sync info to return connection status
    const supabase = createServiceClient()

    const { data: syncState } = await supabase
      .from('email_sync_state')
      .select('last_sync_at')
      .eq('venue_id', auth.venueId)
      .single()

    return NextResponse.json({
      connected: true,
      lastSync: syncState?.last_sync_at ?? null,
    })
  } catch (err) {
    console.error('[api/agent/gmail] POST error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
