/**
 * POST /api/auth/gmail/disconnect
 *
 * Body: { connectionId: string }
 *
 * Disconnects a Gmail connection:
 *   1. Verify the caller is a platform user and the connection belongs to
 *      their venue.
 *   2. Attempt to revoke the refresh token with Google (best effort).
 *   3. Mark the row status='disconnected' and sync_enabled=false. We keep
 *      the row (rather than deleting) so we preserve audit history and so
 *      downstream analytics still resolve the foreign key. Callers that
 *      want a hard delete can use DELETE on /api/agent/gmail?connectionId=X.
 *   4. If this was the primary connection and any active connections remain,
 *      promote the oldest remaining one to primary.
 *
 * Returns { ok: boolean, reason?: string }.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getPlatformAuth } from '@/lib/api/auth-helpers'
import { createServiceClient } from '@/lib/supabase/service'

async function revokeToken(token: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    )
    // Google returns 200 on success, 400 if the token is already invalid.
    // We treat both as "done" — what we care about is the local state.
    return res.ok || res.status === 400
  } catch (err) {
    console.error('[api/auth/gmail/disconnect] revoke request failed:', err)
    return false
  }
}

export async function POST(request: NextRequest) {
  const auth = await getPlatformAuth()
  if (!auth) {
    return NextResponse.json(
      { ok: false, reason: 'unauthorized' },
      { status: 401 }
    )
  }

  let connectionId: string | undefined
  try {
    const body = (await request.json()) as { connectionId?: string }
    connectionId = body.connectionId
  } catch {
    return NextResponse.json(
      { ok: false, reason: 'invalid_body' },
      { status: 400 }
    )
  }

  if (!connectionId || typeof connectionId !== 'string') {
    return NextResponse.json(
      { ok: false, reason: 'missing_connection_id' },
      { status: 400 }
    )
  }

  const supabase = createServiceClient()

  // Load the row and verify ownership
  const { data: row, error: loadError } = await supabase
    .from('gmail_connections')
    .select('id, venue_id, is_primary, gmail_tokens')
    .eq('id', connectionId)
    .maybeSingle()

  if (loadError) {
    console.error('[api/auth/gmail/disconnect] load error:', loadError.message)
    return NextResponse.json(
      { ok: false, reason: 'lookup_failed' },
      { status: 500 }
    )
  }

  if (!row) {
    return NextResponse.json({ ok: false, reason: 'not_found' }, { status: 404 })
  }

  if (row.venue_id !== auth.venueId) {
    return NextResponse.json(
      { ok: false, reason: 'forbidden' },
      { status: 403 }
    )
  }

  // Best-effort revoke
  const tokens = row.gmail_tokens as { refresh_token?: string; access_token?: string } | null
  const revokeTarget = tokens?.refresh_token ?? tokens?.access_token
  if (revokeTarget) {
    await revokeToken(revokeTarget)
  }

  // Mark disconnected
  const { error: updateError } = await supabase
    .from('gmail_connections')
    .update({
      status: 'disconnected',
      sync_enabled: false,
      is_primary: false,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connectionId)

  if (updateError) {
    console.error(
      '[api/auth/gmail/disconnect] update error:',
      updateError.message
    )
    return NextResponse.json(
      { ok: false, reason: 'update_failed' },
      { status: 500 }
    )
  }

  // If this was the primary, promote another active connection
  if (row.is_primary) {
    const { data: remaining } = await supabase
      .from('gmail_connections')
      .select('id')
      .eq('venue_id', auth.venueId)
      .eq('status', 'active')
      .order('created_at', { ascending: true })
      .limit(1)

    if (remaining && remaining.length > 0) {
      await supabase
        .from('gmail_connections')
        .update({ is_primary: true, updated_at: new Date().toISOString() })
        .eq('id', remaining[0].id)
    }
  }

  return NextResponse.json({ ok: true })
}
